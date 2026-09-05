import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { dictations, dictationAudio } from "@/lib/db/schema";
import { bus } from "@/lib/events";
import { createJob, listJobs, retryJob, cancelJob, type Job } from "@/lib/jobs";
import { MAX_AUDIO_BYTES, isSupportedAudioMime } from "@/lib/audio";

export type Dictation = typeof dictations.$inferSelect;
export const MAX_FIELD_KEY_LENGTH = 200;
// Même borne que MAX_SOURCE_TEXT_LENGTH : une dictée de 3 min fait ~600 mots,
// la borne protège la base, pas l'usage. Hors borne = throw, jamais tronqué.
export const MAX_DICTATION_TEXT_LENGTH = 200_000;
const MAX_ERROR_LENGTH = 2000;

function publish(d: Dictation, status: string = d.status) {
  bus.publish(d.workspaceId, { type: "dictation.updated", dictationId: d.id, fieldKey: d.fieldKey, status });
}

export async function createDictation(workspaceId: string, input: {
  audio: Buffer; mime: string; fieldKey?: string; createdBy?: string;
}): Promise<{ dictation: Dictation; job: Job }> {
  if (!input.audio.length) throw new Error("audio vide");
  if (input.audio.length > MAX_AUDIO_BYTES) throw new Error(`audio trop gros (max ${MAX_AUDIO_BYTES} octets)`);
  if (!isSupportedAudioMime(input.mime)) throw new Error(`mime audio non supporté : ${input.mime}`);
  const fieldKey = input.fieldKey ?? "";
  if (fieldKey.length > MAX_FIELD_KEY_LENGTH) throw new Error(`field_key trop long (max ${MAX_FIELD_KEY_LENGTH} caractères)`);

  const dictation = await db.transaction(async (tx) => {
    const values: Record<string, unknown> = { workspaceId, fieldKey };
    if (input.createdBy !== undefined) values.createdBy = input.createdBy;
    const [row] = await tx.insert(dictations).values(values as never).returning();
    await tx.insert(dictationAudio).values({
      dictationId: row.id, mime: input.mime, bytes: input.audio, size: input.audio.length,
    });
    return row;
  });
  publish(dictation);
  // createJob a sa propre transaction (verrou avisé) : hors de celle du dessus.
  // S'il échoue, la dictée ne doit pas rester pending sans job ni recours :
  // failed (audio conservé, Réessayer possible) avant de propager l'erreur.
  let job: Job;
  try {
    ({ job } = await createJob(workspaceId, {
      kind: "transcribe", targetType: "dictation", targetId: dictation.id,
      payload: { field_key: fieldKey, mime: input.mime, size: input.audio.length },
      requestedBy: input.createdBy ? `user:${input.createdBy}` : "system:dictation",
    }));
  } catch (e) {
    await failDictation(workspaceId, dictation.id, "job de transcription impossible à créer");
    throw e;
  }
  return { dictation, job };
}

export async function getDictation(workspaceId: string, id: string): Promise<Dictation | null> {
  const [row] = await db.select().from(dictations)
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId)));
  return row ?? null;
}

/** L'audio, cloisonné via la dictée parente (jointure). null = introuvable ou purgé. */
export async function getDictationAudio(workspaceId: string, id: string) {
  const [row] = await db.select({ mime: dictationAudio.mime, bytes: dictationAudio.bytes, size: dictationAudio.size })
    .from(dictationAudio)
    .innerJoin(dictations, eq(dictations.id, dictationAudio.dictationId))
    .where(and(eq(dictationAudio.dictationId, id), eq(dictations.workspaceId, workspaceId)));
  return row ?? null;
}

export async function listDictations(workspaceId: string, filter: {
  status?: "pending" | "done" | "failed"; fieldKey?: string; open?: boolean; limit?: number;
}) {
  const conds = [eq(dictations.workspaceId, workspaceId)];
  if (filter.status) conds.push(eq(dictations.status, filter.status));
  if (filter.fieldKey !== undefined) conds.push(eq(dictations.fieldKey, filter.fieldKey));
  // open = ce qu'un champ attend encore : en cours, ou prête mais jamais insérée
  if (filter.open) conds.push(or(
    eq(dictations.status, "pending"),
    and(eq(dictations.status, "done"), isNull(dictations.consumedAt)),
  )!);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  return db.select().from(dictations).where(and(...conds))
    .orderBy(desc(dictations.createdAt)).limit(limit);
}

/** Effet de complétion d'un job transcribe/dictation — appelé par jobs.ts. */
export async function applyDictation(workspaceId: string, id: string, text: string) {
  if (text.length > MAX_DICTATION_TEXT_LENGTH) throw new Error(`text trop long (max ${MAX_DICTATION_TEXT_LENGTH} caractères)`);
  const [row] = await db.update(dictations)
    .set({ status: "done", text, error: null, updatedAt: new Date() })
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId)))
    .returning();
  if (!row) return null;
  await db.delete(dictationAudio).where(eq(dictationAudio.dictationId, id)); // purge : la transcription a réussi
  publish(row);
  return row;
}

/** Effet d'échec — jamais sur une dictée déjà done (le texte posé prime). */
export async function failDictation(workspaceId: string, id: string, reason: string) {
  const [row] = await db.update(dictations)
    .set({ status: "failed", error: (reason || "échec sans message").slice(0, MAX_ERROR_LENGTH), updatedAt: new Date() })
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId), ne(dictations.status, "done")))
    .returning();
  if (row) publish(row);
  return row ?? null;
}

/**
 * Le champ a inséré le texte. Idempotent : un second appel rend la ligne
 * telle quelle. `first` indique si CET appel a posé `consumedAt` (garde
 * `isNull(consumedAt)`) — livraison « claim-first » (revue finale, I1) :
 * quand plusieurs instances d'un même champ partagent la même clé (ou, plus
 * généralement, si un même événement est traité deux fois), une seule doit
 * insérer le texte ; `first: false` dit à l'appelant de retirer l'id de son
 * compteur SANS rien insérer. `null` = dictée introuvable dans ce workspace.
 */
export async function consumeDictation(workspaceId: string, id: string) {
  const [row] = await db.update(dictations)
    .set({ consumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId), isNull(dictations.consumedAt)))
    .returning();
  if (row) { publish(row, "consumed"); return { ...row, first: true }; }
  const existing = await getDictation(workspaceId, id);
  return existing ? { ...existing, first: false } : null;
}

/** failed → pending, et repose le job (retry du dernier failed, sinon un neuf). */
export async function retryDictation(workspaceId: string, id: string) {
  const existing = await getDictation(workspaceId, id);
  if (!existing) return null;
  if (existing.status !== "failed") throw new Error(`réessai refusé : dictée en statut ${existing.status}`);
  // Présence seule (le workspace est déjà vérifié par getDictation) : ne pas
  // charger jusqu'à 16 Mio de bytea juste pour un test d'existence.
  const [audio] = await db.select({ size: dictationAudio.size }).from(dictationAudio)
    .where(eq(dictationAudio.dictationId, id));
  if (!audio) throw new Error("réessai refusé : audio absent");
  const [row] = await db.update(dictations)
    .set({ status: "pending", error: null, updatedAt: new Date() })
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId), eq(dictations.status, "failed")))
    .returning();
  if (!row) throw new Error("réessai refusé : la dictée a changé entre-temps");
  const failedJobs = await listJobs(workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id, status: "failed" });
  if (failedJobs[0]) {
    try {
      await retryJob(workspaceId, failedJobs[0].id);
    } catch {
      await createJob(workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id, payload: { field_key: row.fieldKey } });
    }
  } else {
    await createJob(workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id, payload: { field_key: row.fieldKey } });
  }
  publish(row);
  return row;
}

/** Supprime la dictée (audio en cascade) et annule un job encore queued. false = introuvable. */
export async function deleteDictation(workspaceId: string, id: string): Promise<boolean> {
  const existing = await getDictation(workspaceId, id);
  if (!existing) return false;
  const [deleted] = await db.delete(dictations)
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId)))
    .returning();
  if (!deleted) return false;
  // Après la suppression : l'effet d'échec du cancel ne trouve plus la ligne, rien à rétrograder.
  const queued = await listJobs(workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id, status: "queued" });
  for (const j of queued) {
    try { await cancelJob(workspaceId, j.id); } catch { /* déjà pris : le worker échouera sur l'audio absent */ }
  }
  publish(existing, "deleted");
  return true;
}
