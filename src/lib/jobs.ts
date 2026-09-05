import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentJobs, contentComments, contents, dictations, ideas, sources } from "@/lib/db/schema";
import { bus } from "@/lib/events";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobTargetType = "idea" | "content" | "comment" | "source" | "dictation";
export type Job = typeof agentJobs.$inferSelect;

export const SILENT_AFTER_MS = 10 * 60_000;
export const MAX_JOB_ERROR_LENGTH = 2000;
export const MAX_JOB_JSON_BYTES = 64 * 1024;
// Le texte d'un transcribe vit dans result : un transcript de 3 h dépasse
// les 64 Kio des autres kinds. Plafond aligné sur MAX_DICTATION_TEXT_LENGTH
// (200 000 caractères + enveloppe JSON), jamais tronqué en silence.
export const MAX_TRANSCRIBE_RESULT_BYTES = 512 * 1024;
export const MAX_JOB_KIND_LENGTH = 64;
export const SILENT_ERROR = "agent silencieux (aucun battement depuis 10 min)";

/** Transition interdite depuis l'état courant → 409 côté HTTP/MCP. */
export class JobStateError extends Error {
  code = "job_state" as const;
  http = 409 as const;
}

function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v ?? {}), "utf8");
}

function publish(job: Job) {
  bus.publish(job.workspaceId, {
    type: "job.updated", jobId: job.id, kind: job.kind,
    targetType: job.targetType, targetId: job.targetId, status: job.status,
  });
}

/**
 * La cible doit exister DANS ce workspace. target_id n'a pas de FK (trois
 * tables possibles) : c'est ici, et seulement ici, que le lien est garanti.
 */
async function assertTarget(workspaceId: string, targetType: JobTargetType, targetId: string) {
  if (targetType === "idea") {
    const [row] = await db.select({ id: ideas.id }).from(ideas)
      .where(and(eq(ideas.id, targetId), eq(ideas.workspaceId, workspaceId)));
    if (row) return;
  } else if (targetType === "content") {
    const [row] = await db.select({ id: contents.id }).from(contents)
      .where(and(eq(contents.id, targetId), eq(contents.workspaceId, workspaceId)));
    if (row) return;
  } else if (targetType === "comment") {
    const [row] = await db.select({ id: contentComments.id }).from(contentComments)
      .where(and(eq(contentComments.id, targetId), eq(contentComments.workspaceId, workspaceId)));
    if (row) return;
  } else if (targetType === "source") {
    const [row] = await db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.id, targetId), eq(sources.workspaceId, workspaceId)));
    if (row) return;
  } else if (targetType === "dictation") {
    const [row] = await db.select({ id: dictations.id }).from(dictations)
      .where(and(eq(dictations.id, targetId), eq(dictations.workspaceId, workspaceId)));
    if (row) return;
  }
  throw new Error("cible introuvable dans ce workspace");
}

export async function createJob(workspaceId: string, input: {
  kind: string; targetType: JobTargetType; targetId: string;
  payload?: Record<string, unknown>; requestedBy?: string; coalesce?: boolean;
  // Distingue plusieurs jobs légitimes sur la MÊME cible (ex. deux publications
  // d'un même contenu à re-synchroniser) : sans clé, ils partagent l'unicité
  // (workspace, kind, cible) et le second se coalesce sur le premier, qui
  // l'ignore puisque son payload ne parle que de l'autre publication. Écrite
  // dans payload.dedupe_key (le worker l'ignore) et injectée dans le verrou et
  // le filtre des jobs actifs ; absente → comportement identique à avant.
  dedupeKey?: string;
}): Promise<{ job: Job; created: boolean }> {
  const kind = input.kind.trim();
  if (!kind) throw new Error("kind requis");
  if (kind.length > MAX_JOB_KIND_LENGTH) throw new Error(`kind trop long (max ${MAX_JOB_KIND_LENGTH} caractères)`);
  // payload.dedupe_key est un champ réservé : seul `input.dedupeKey` (qui
  // alimente aussi le verrou et le filtre des jobs actifs) peut l'écrire.
  // Sans ce nettoyage, un appelant (MCP, route) pourrait glisser son propre
  // dedupe_key dans le payload et défaire l'unicité sans jamais influencer le
  // verrou, qui continuerait à raisonner sur "" (Finding, review finale).
  const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
  delete payload.dedupe_key;
  if (input.dedupeKey !== undefined) payload.dedupe_key = input.dedupeKey;
  if (jsonBytes(payload) > MAX_JOB_JSON_BYTES) throw new Error(`payload trop gros (max ${MAX_JOB_JSON_BYTES} octets)`);
  await assertTarget(workspaceId, input.targetType, input.targetId);
  const dedupeKey = input.dedupeKey ?? "";

  const r = await db.transaction(async (tx) => {
    // Verrou consultatif par (workspace, kind, cible, dedupeKey) le temps de la
    // transaction : deux créations simultanées (double clic, hook + bouton) ne
    // peuvent pas toutes deux conclure « aucun job actif » et insérer chacune
    // le leur.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:${kind}:${input.targetId}:${dedupeKey}`}))`);
    const active = await tx.select().from(agentJobs).where(and(
      eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.kind, kind),
      eq(agentJobs.targetType, input.targetType), eq(agentJobs.targetId, input.targetId),
      inArray(agentJobs.status, ["queued", "running"]),
      sql`coalesce(${agentJobs.payload}->>'dedupe_key', '') = ${dedupeKey}`,
    )).orderBy(desc(agentJobs.createdAt));
    const queued = active.find((j) => j.status === "queued");
    const running = active.find((j) => j.status === "running");
    if (!input.coalesce && (queued || running)) return { job: (queued ?? running)!, created: false };
    if (input.coalesce && queued) return { job: queued, created: false };
    const values: Record<string, unknown> = {
      workspaceId, kind, targetType: input.targetType, targetId: input.targetId, payload,
    };
    if (input.requestedBy !== undefined) values.requestedBy = input.requestedBy;
    const [row] = await tx.insert(agentJobs).values(values as never).returning();
    return { job: row, created: true };
  });
  if (r.created) publish(r.job);
  return r;
}

export async function getJob(workspaceId: string, id: string): Promise<Job | null> {
  const [row] = await db.select().from(agentJobs)
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId)));
  return row ?? null;
}

/**
 * Un job running sans battement depuis SILENT_AFTER_MS → failed. Appelé
 * paresseusement par listJobs (pas de cron dans l'outil) : c'est ce qui
 * libère l'unicité quand un worker meurt au milieu d'un travail.
 */
export async function sweepSilentJobs(workspaceId: string): Promise<number> {
  // Interpolé en ISO : un Date brut dans un sql`` échappe au mapping timestamp
  // normalement appliqué aux valeurs liées à une colonne, et postgres.js reçoit
  // alors un Date.toString() illisible comme paramètre → erreur au driver.
  const limit = new Date(Date.now() - SILENT_AFTER_MS).toISOString();
  const rows = await db.update(agentJobs)
    .set({ status: "failed", error: SILENT_ERROR, finishedAt: new Date() })
    .where(and(
      eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "running"),
      sql`coalesce(${agentJobs.lastHeartbeatAt}, ${agentJobs.startedAt}, ${agentJobs.createdAt}) < ${limit}`,
    )).returning();
  for (const row of rows) {
    publish(row);
    // Même garantie que failJob : la transition est déjà committée, une panne
    // d'effet (ex. commentaire déjà supprimé) ne doit jamais remonter — sinon
    // un worker mort au milieu d'une dictée laisserait le commentaire
    // « pending » pour toujours, sans même l'affordance « Réessayer ».
    try {
      await applyFailureEffects(row, SILENT_ERROR);
    } catch (e) {
      console.error("applyFailureEffects a échoué après sweepSilentJobs", e);
    }
  }
  return rows.length;
}

export async function listJobs(workspaceId: string, filter: {
  status?: JobStatus; kind?: string; targetType?: JobTargetType; targetId?: string;
  order?: "asc" | "desc";
}) {
  await sweepSilentJobs(workspaceId);
  const conds = [eq(agentJobs.workspaceId, workspaceId)];
  if (filter.status) conds.push(eq(agentJobs.status, filter.status));
  if (filter.kind) conds.push(eq(agentJobs.kind, filter.kind));
  if (filter.targetType) conds.push(eq(agentJobs.targetType, filter.targetType));
  if (filter.targetId) conds.push(eq(agentJobs.targetId, filter.targetId));
  return db.select({
    ...getTableColumns(agentJobs),
    // Identifiants qualifiés À LA MAIN (même piège que listIdeas : un ${agentJobs.targetId}
    // interpolé sortirait "target_id" non qualifié, lié à la table la plus proche).
    targetTitle: sql<string | null>`(case
      when agent_jobs.target_type = 'idea' then (select i.title from ideas i where i.id = agent_jobs.target_id)
      when agent_jobs.target_type = 'content' then (select i2.title from contents c join ideas i2 on i2.id = c.idea_id where c.id = agent_jobs.target_id)
      when agent_jobs.target_type = 'source' then (select coalesce(nullif(s.title, ''), s.ref) from sources s where s.id = agent_jobs.target_id)
      when agent_jobs.target_type = 'dictation' then (select 'Dictée ' || d.field_key from dictations d where d.id = agent_jobs.target_id)
      else null end)`,
  }).from(agentJobs)
    .where(and(...conds))
    .orderBy(filter.order === "asc" ? asc(agentJobs.createdAt) : desc(agentJobs.createdAt));
}

/** null = introuvable dans ce workspace ; JobStateError = existe mais pas queued. */
export async function claimJob(workspaceId: string, id: string, workerLabel: string): Promise<Job | null> {
  const now = new Date();
  const [row] = await db.update(agentJobs)
    .set({ status: "running", claimedBy: workerLabel, startedAt: now, lastHeartbeatAt: now })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "queued")))
    .returning();
  if (row) { publish(row); return row; }
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  throw new JobStateError(`job déjà pris ou terminé (statut ${existing.status})`);
}

export async function heartbeatJob(workspaceId: string, id: string): Promise<Job | null> {
  const [row] = await db.update(agentJobs)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "running")))
    .returning();
  if (row) return row;
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  throw new JobStateError(`battement refusé : job en statut ${existing.status}`);
}

async function finish(workspaceId: string, id: string, set: Partial<typeof agentJobs.$inferInsert>): Promise<Job | null> {
  const [row] = await db.update(agentJobs)
    .set({ ...set, finishedAt: new Date() })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "running")))
    .returning();
  if (row) { publish(row); return row; }
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  throw new JobStateError(`transition refusée depuis le statut ${existing.status}`);
}

export async function completeJob(workspaceId: string, id: string, result: Record<string, unknown> = {}): Promise<Job | null> {
  const current = await getJob(workspaceId, id);
  const maxResult = current?.kind === "transcribe" ? MAX_TRANSCRIBE_RESULT_BYTES : MAX_JOB_JSON_BYTES;
  if (jsonBytes(result) > maxResult) throw new Error(`result trop gros (max ${maxResult} octets)`);
  // Un transcribe (commentaire OU dictée) sans result.text ne doit jamais
  // passer done avec une cible qui resterait pending pour toujours : vérifié
  // AVANT finish, le job reste running (retry possible).
  if (current?.kind === "transcribe" && (current.targetType === "comment" || current.targetType === "dictation")
    && typeof result.text !== "string")
    throw new Error("result.text requis pour un job transcribe");
  // Même famille de garde que transcribe : un extract ne passe jamais done
  // avec une source restée pending — le job reste running, le worker corrige
  // (attach_extraction) puis retente.
  if (current?.kind === "extract" && current.targetType === "source") {
    // Import dynamique : sources.ts importe jobs.ts (createJob) — un import
    // statique inverse ferait un cycle au chargement des modules.
    const { getSource } = await import("@/lib/sources");
    const src = await getSource(workspaceId, current.targetId);
    if (!src || src.status !== "extracted")
      throw new Error("complete refusé : source non extraite — appeler attach_extraction d'abord");
  }
  const row = await finish(workspaceId, id, { status: "done", result });
  // Effet post-commit non bloquant : le job est déjà passé done, une erreur
  // ici ne doit jamais faire échouer l'appelant (même style que failJob).
  if (row && row.kind === "transcribe" && row.targetType === "comment") {
    try {
      const { applyTranscription } = await import("@/lib/comments");
      await applyTranscription(workspaceId, row.targetId, result.text as string);
    } catch (e) {
      console.error("applyTranscription a échoué après completeJob", e);
    }
  }
  if (row && row.kind === "transcribe" && row.targetType === "dictation") {
    try {
      // Import dynamique : dictations.ts importe jobs.ts (createJob).
      const { applyDictation } = await import("@/lib/dictations");
      await applyDictation(workspaceId, row.targetId, result.text as string);
    } catch (e) {
      console.error("applyDictation a échoué après completeJob", e);
    }
  }
  return row;
}

export async function failJob(workspaceId: string, id: string, error: string): Promise<Job | null> {
  const message = (error || "échec sans message").slice(0, MAX_JOB_ERROR_LENGTH);
  const row = await finish(workspaceId, id, { status: "failed", error: message });
  // Effet post-commit non bloquant : le job est déjà passé failed, une erreur
  // ici (ex. publication_id malformé) ne doit jamais faire échouer l'appelant.
  if (row) {
    try {
      await applyFailureEffects(row, message);
    } catch (e) {
      console.error("applyFailureEffects a échoué après failJob", e);
    }
  }
  return row;
}

/** Effets d'échec des kinds intégrés (spec §1.4 / §2.2). */
async function applyFailureEffects(job: Job, message: string) {
  const payload = job.payload as Record<string, unknown>;
  if (job.kind === "sync" && typeof payload.publication_id === "string") {
    // Import dynamique : publications.ts importe jobs.ts pour createJob —
    // un import statique inverse ferait un cycle au chargement des modules.
    const { setPublicationError } = await import("@/lib/publications");
    await setPublicationError(job.workspaceId, payload.publication_id, message);
  }
  if (job.kind === "transcribe" && job.targetType === "comment") {
    // Même raison : comments.ts importe jobs.ts pour createJob.
    const { failTranscription } = await import("@/lib/comments");
    await failTranscription(job.workspaceId, job.targetId);
  }
  if (job.kind === "extract" && job.targetType === "source") {
    // Même raison d'import dynamique : sources.ts importe jobs.ts.
    const { markSourceFailed } = await import("@/lib/sources");
    await markSourceFailed(job.workspaceId, job.targetId, message);
  }
  if (job.kind === "transcribe" && job.targetType === "dictation") {
    const { failDictation } = await import("@/lib/dictations");
    await failDictation(job.workspaceId, job.targetId, message);
  }
}

export async function retryJob(workspaceId: string, id: string): Promise<Job | null> {
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  if (existing.status !== "failed") throw new JobStateError(`réessai refusé : job en statut ${existing.status}`);
  const payload = { ...(existing.payload as Record<string, unknown>) };
  const previous = Array.isArray(payload.previous_errors) ? (payload.previous_errors as string[]) : [];
  payload.previous_errors = [...previous, existing.error ?? ""].slice(-10);
  const [row] = await db.update(agentJobs)
    .set({
      status: "queued", attempts: existing.attempts + 1, error: null, result: {},
      claimedBy: null, lastHeartbeatAt: null, startedAt: null, finishedAt: null, payload,
    })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "failed")))
    .returning();
  if (!row) throw new JobStateError("réessai refusé : le job a changé entre-temps");
  publish(row);
  return row;
}

export async function cancelJob(workspaceId: string, id: string): Promise<Job | null> {
  const [row] = await db.update(agentJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "queued")))
    .returning();
  if (row) {
    publish(row);
    // Même garantie que failJob/sweepSilentJobs : la transition est déjà
    // committée, une panne d'effet ne doit jamais faire échouer l'appelant.
    // Pour un transcribe/comment annulé, ça bascule la transcription en
    // « failed » (affordance « Réessayer ») plutôt que de la laisser pending
    // à vie côté commentaire.
    try {
      await applyFailureEffects(row, "annulé");
    } catch (e) {
      console.error("applyFailureEffects a échoué après cancelJob", e);
    }
    return row;
  }
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  throw new JobStateError(`annulation refusée : job en statut ${existing.status}`);
}
