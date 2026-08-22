# Vague « cockpit agent » — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire de content-studio le poste de pilotage d'un worker externe : jobs (demandes consommées par MCP), publications (lien vers l'objet publié + re-sync quand on édite), relecture & dictée (commentaires ancrés, audio transcrit par le worker).

**Architecture:** Trois briques additives, chacune = table(s) drizzle + lib `src/lib/*.ts` (toute règle métier vit ici) + outils MCP dans `src/app/api/[transport]/route.ts` + routes session `src/app/api/**` + UI dans les pages existantes. Le studio n'exécute rien : il écrit des lignes, émet des événements SSE, et un worker (hors repo) fait le travail via MCP. Toute lecture/écriture est cloisonnée par `workspace_id`.

**Tech Stack:** Next.js 16 (App Router, route handlers), drizzle-orm + postgres-js, better-auth (sessions), mcp-handler 2 + zod 4 (MCP), tiptap (rendu markdown), vitest (single-run, DB de test locale).

**Spec:** `docs/specs/2026-08-22-cockpit-agent-design.md`

## Global Constraints

- Tests : `npx vitest run` **uniquement** (jamais `npx vitest`). Pré-requis : `docker compose up -d postgres` (la DB de test `content_studio_test` est migrée par `tests/setup.global.ts`). `fileParallelism: false` — ne pas paralléliser.
- Typecheck : `npx tsc --noEmit -p tsconfig.json` (petit graphe, OK en direct).
- Cloisonnement : **toute** requête sur une table de domaine porte `workspace_id` ; une cible d'un autre workspace = « introuvable » (404 / `{error}`), jamais une fuite.
- Enums = `text(..., { enum: [...] })` comme le reste du schéma ; pas de `pgEnum`.
- Valeurs hors bornes = entrée cassée (400 / throw), jamais tronquée en silence — sauf `agent_jobs.error` (tronqué à 2 000, documenté).
- Bornes : `agent_jobs.error` 2 000 car. ; `payload`/`result` 64 Ko ; audio 16 Mo ; `quote` 2 000 ; `comment.body` 10 000.
- Migrations : `DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npx drizzle-kit generate` après chaque modif de `src/lib/db/schema.ts` ; commiter le `.sql` + `drizzle/meta/*`.
- Messages d'erreur et UI en français ; commits par chemins explicites (`git add <fichiers>`), jamais `git add -A`.
- Conventions de style existantes : libs avec `values: Record<string, unknown>` ne posant que les champs définis ; routes qui mappent `TenantError` → 401, « introuvable » → 404 ; tests par `signUpTestUser()` (un workspace neuf par test).

---

## Carte des fichiers

**Créés**
- `src/lib/jobs.ts` — règles des jobs (création/unicité/coalescence, claim atomique, heartbeat, complete/fail, retry/cancel, balayage des silencieux, résumé de cible).
- `src/lib/publications.ts` — upsert/lecture des publications, `mark_synced`, `last_error`, hash de corps.
- `src/lib/anchoring.ts` — `findPassage(full, quote, prefix, suffix)` (port de VDL), pur, sans DB.
- `src/lib/comments.ts` — CRUD commentaires, commentaire vocal + audio + job `transcribe`, purge audio.
- `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/retry/route.ts`, `src/app/api/jobs/[id]/cancel/route.ts`, `src/app/api/jobs/[id]/audio/route.ts`.
- `src/app/api/contents/[id]/publications/route.ts`, `src/app/api/contents/[id]/comments/route.ts`, `src/app/api/contents/[id]/comments/[cid]/route.ts`, `src/app/api/contents/[id]/comments/audio/route.ts`.
- `src/hooks/use-jobs.ts`, `src/components/cockpit/job-status.tsx`, `src/components/cockpit/publication-card.tsx`, `src/components/review/review-pane.tsx`, `src/components/review/comment-popover.tsx`, `src/components/review/comment-list.tsx`, `src/components/review/use-recorder.ts`.
- Tests : `tests/jobs.test.ts`, `tests/jobs-routes.test.ts`, `tests/mcp-jobs.test.ts`, `tests/publications.test.ts`, `tests/mcp-publications.test.ts`, `tests/anchoring.test.ts`, `tests/comments.test.ts`, `tests/comments-routes.test.ts`, `tests/mcp-comments.test.ts`.

**Modifiés**
- `src/lib/db/schema.ts` (+ `agentJobs`, `publications`, `contentComments`, `commentAudio`), `drizzle/*` (3 migrations).
- `src/lib/events.ts` (+ `job.updated`, `comment.updated`), `src/lib/contents.ts` (hook de re-sync dans `applyContentUpdate`), `src/lib/ideas.ts` (`lastJobStatus` dans `listIdeas`).
- `src/app/api/[transport]/route.ts` (+ 12 outils).
- `src/app/(app)/ideas/[id]/page.tsx`, `src/app/(app)/contents/[id]/page.tsx`, `src/app/(app)/page.tsx`, `src/components/cockpit/status-badge.tsx`.
- `tests/helpers.ts` (+ `sessionCookie`, `authedReq`), `README.md` (section « Worker externe : jobs, publications, relecture »).

---

# Partie 1 — Jobs

### Task 1: Table `agent_jobs` + migration

**Files:**
- Modify: `src/lib/db/schema.ts` (après `workspaceSettings`, avant `assets`)
- Create: `drizzle/0004_*.sql` (généré)
- Test: `tests/schema.test.ts` (ajout)

**Interfaces:**
- Produces: export drizzle `agentJobs` (colonnes ci-dessous), utilisé par `src/lib/jobs.ts`.

- [ ] **Step 1: Écrire le test de présence de la table**

Dans `tests/schema.test.ts`, ajouter (même style que les `it` existants qui lisent `tableNames()`) :

```ts
it("la table agent_jobs existe (Task 1, vague cockpit agent)", async () => {
  const names = await tableNames();
  expect(names).toContain("agent_jobs");
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `npx vitest run tests/schema.test.ts`
Expected: FAIL — `expected [...] to include 'agent_jobs'`.

- [ ] **Step 3: Ajouter la table au schéma**

Dans `src/lib/db/schema.ts`, juste avant `export const assets` :

```ts
// ---- jobs (vague « cockpit agent ») ------------------------------------
// Une demande de travail posée par l'humain (bouton) ou par une règle de
// l'outil (hook), consommée par un worker EXTERNE via MCP. L'outil n'exécute
// rien : il consigne, cloisonne, notifie. target_id n'a pas de FK (trois
// tables cibles) : la lib vérifie la cible dans CE workspace à la création.
export const agentJobs = pgTable("agent_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  targetType: text("target_type", { enum: ["idea", "content", "comment"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] })
    .notNull().default("queued"),
  result: jsonb("result").notNull().default({}),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  requestedBy: text("requested_by"),
  claimedBy: text("claimed_by"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
}, (t) => [
  index("agent_jobs_ws_status").on(t.workspaceId, t.status),
  index("agent_jobs_target").on(t.workspaceId, t.targetType, t.targetId),
]);
```

- [ ] **Step 4: Générer la migration**

Run: `DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npx drizzle-kit generate`
Expected: un nouveau fichier `drizzle/0004_<nom>.sql` contenant `CREATE TABLE "agent_jobs"` et les deux `CREATE INDEX`, et `drizzle/meta/_journal.json` mis à jour (idx 4).

- [ ] **Step 5: Relancer le test**

Run: `npx vitest run tests/schema.test.ts`
Expected: PASS (le `globalSetup` applique la migration sur la DB de test).

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts drizzle/ tests/schema.test.ts
git commit -m "feat(jobs): table agent_jobs — demandes de travail consommées par un worker externe"
```

---

### Task 2: Lib `jobs.ts` — création, unicité, claim, heartbeat, complete/fail, retry/cancel, silence

**Files:**
- Create: `src/lib/jobs.ts`
- Modify: `src/lib/events.ts` (ajout du type `job.updated`)
- Test: `tests/jobs.test.ts`

**Interfaces:**
- Consumes: `agentJobs`, `ideas`, `contents` (schéma), `bus` (events), `createIdea`, `createContentDraft` (tests).
- Produces (utilisé par Tasks 3, 4, 7, 12, 13) :
  - `type JobStatus = "queued"|"running"|"done"|"failed"|"cancelled"`, `type JobTargetType = "idea"|"content"|"comment"`
  - `class JobStateError extends Error { code: "job_state"; http: 409 }`
  - `createJob(workspaceId, { kind, targetType, targetId, payload?, requestedBy?, coalesce? }) → Promise<{ job: Job; created: boolean }>`
  - `listJobs(workspaceId, { status?, kind?, targetType?, targetId?, order? }) → Promise<Array<Job & { targetTitle: string|null }>>`
  - `getJob(workspaceId, id) → Promise<Job|null>`
  - `claimJob(workspaceId, id, workerLabel) → Promise<Job|null>` (null = introuvable ; throw `JobStateError` si pas `queued`)
  - `heartbeatJob(workspaceId, id) → Promise<Job|null>`
  - `completeJob(workspaceId, id, result?) → Promise<Job|null>`
  - `failJob(workspaceId, id, error) → Promise<Job|null>`
  - `retryJob(workspaceId, id) → Promise<Job|null>`, `cancelJob(workspaceId, id) → Promise<Job|null>`
  - `sweepSilentJobs(workspaceId) → Promise<number>`
  - constantes `SILENT_AFTER_MS = 600_000`, `MAX_JOB_ERROR_LENGTH = 2000`, `MAX_JOB_JSON_BYTES = 65_536`, `MAX_JOB_KIND_LENGTH = 64`

- [ ] **Step 1: Écrire les tests**

`tests/jobs.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, signUpTestUser } from "./helpers";
import { agentJobs } from "@/lib/db/schema";
import { createIdea } from "@/lib/ideas";
import { createContentDraft } from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";
import {
  createJob, listJobs, getJob, claimJob, heartbeatJob, completeJob, failJob,
  retryJob, cancelJob, sweepSilentJobs, JobStateError,
  MAX_JOB_ERROR_LENGTH, MAX_JOB_JSON_BYTES,
} from "@/lib/jobs";

async function ideaIn(ws: { workspaceId: string }) {
  return createIdea(ws.workspaceId, { title: "Idée pour job" });
}

describe("jobs — création et unicité", () => {
  it("crée un job queued sur une idée du workspace", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job, created } = await createJob(ws.workspaceId, {
      kind: "write", targetType: "idea", targetId: idea.id,
      payload: { channel_key: "community" }, requestedBy: "user:test",
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("write");
    expect(job.payload).toEqual({ channel_key: "community" });
    expect(job.attempts).toBe(0);
  });

  it("refuse une cible d'un autre workspace ou inexistante", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const ideaB = await ideaIn(b);
    await expect(createJob(a.workspaceId, { kind: "write", targetType: "idea", targetId: ideaB.id }))
      .rejects.toThrow(/introuvable/);
    await expect(createJob(a.workspaceId, { kind: "write", targetType: "content", targetId: crypto.randomUUID() }))
      .rejects.toThrow(/introuvable/);
  });

  it("sans coalesce : un job actif existant est rendu, rien n'est créé", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const first = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const second = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    // même après claim (running), toujours pas de doublon
    await claimJob(ws.workspaceId, first.job.id, "w1");
    const third = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(third.created).toBe(false);
    expect(third.job.id).toBe(first.job.id);
  });

  it("avec coalesce : un queued est rendu ; un running seul laisse créer UN queued", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const a = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    const b = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    await claimJob(ws.workspaceId, a.job.id, "w1");
    const c = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(c.created).toBe(true);
    expect(c.job.id).not.toBe(a.job.id);
    const d = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(d.created).toBe(false);
    expect(d.job.id).toBe(c.job.id);
  });

  it("un kind différent sur la même cible n'est pas dédoublonné", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const w = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const x = await createJob(ws.workspaceId, { kind: "autre", targetType: "idea", targetId: idea.id });
    expect(x.created).toBe(true);
    expect(x.job.id).not.toBe(w.job.id);
  });

  it("bornes : kind vide ou payload > 64 Ko refusés", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    await expect(createJob(ws.workspaceId, { kind: "  ", targetType: "idea", targetId: idea.id }))
      .rejects.toThrow(/kind requis/);
    const gros = { blob: "x".repeat(MAX_JOB_JSON_BYTES + 1) };
    await expect(createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id, payload: gros }))
      .rejects.toThrow(/payload trop gros/);
  });
});

describe("jobs — cycle de vie", () => {
  it("claim atomique : deux claims concurrents, un seul gagnant", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const results = await Promise.allSettled([
      claimJob(ws.workspaceId, job.id, "w1"),
      claimJob(ws.workspaceId, job.id, "w2"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(JobStateError);
    const claimed = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimJob>>>).value!;
    expect(claimed.status).toBe("running");
    expect(["w1", "w2"]).toContain(claimed.claimedBy);
    expect(claimed.startedAt).not.toBeNull();
    expect(claimed.lastHeartbeatAt).not.toBeNull();
  });

  it("claim d'un job d'un autre workspace → null (introuvable), jamais pris", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await ideaIn(a);
    const { job } = await createJob(a.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(await claimJob(b.workspaceId, job.id, "intrus")).toBeNull();
    expect((await getJob(a.workspaceId, job.id))!.status).toBe("queued");
  });

  it("complete depuis running → done avec result ; complete depuis queued → JobStateError", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toBeInstanceOf(JobStateError);
    await claimJob(ws.workspaceId, job.id, "w1");
    const done = await completeJob(ws.workspaceId, job.id, { content_id: "abc" });
    expect(done!.status).toBe("done");
    expect(done!.result).toEqual({ content_id: "abc" });
    expect(done!.finishedAt).not.toBeNull();
  });

  it("fail → failed avec erreur tronquée à 2 000 ; retry → queued, attempts+1, erreur archivée", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    const failed = await failJob(ws.workspaceId, job.id, "E".repeat(MAX_JOB_ERROR_LENGTH + 50));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toHaveLength(MAX_JOB_ERROR_LENGTH);
    const retried = await retryJob(ws.workspaceId, job.id);
    expect(retried!.status).toBe("queued");
    expect(retried!.attempts).toBe(1);
    expect(retried!.error).toBeNull();
    expect(retried!.claimedBy).toBeNull();
    expect((retried!.payload as { previous_errors: string[] }).previous_errors).toHaveLength(1);
    // retry d'un job non failed → JobStateError
    await expect(retryJob(ws.workspaceId, job.id)).rejects.toBeInstanceOf(JobStateError);
  });

  it("cancel : queued → cancelled ; running → JobStateError", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect((await cancelJob(ws.workspaceId, job.id))!.status).toBe("cancelled");
    const { job: j2 } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(j2.id).not.toBe(job.id); // cancelled n'est plus actif → nouveau job
    await claimJob(ws.workspaceId, j2.id, "w1");
    await expect(cancelJob(ws.workspaceId, j2.id)).rejects.toBeInstanceOf(JobStateError);
  });

  it("heartbeat met à jour lastHeartbeatAt ; silence > 10 min → failed « agent silencieux »", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    const before = (await getJob(ws.workspaceId, job.id))!.lastHeartbeatAt!;
    await new Promise((r) => setTimeout(r, 20));
    const hb = await heartbeatJob(ws.workspaceId, job.id);
    expect(hb!.lastHeartbeatAt!.getTime()).toBeGreaterThan(before.getTime());

    // on recule artificiellement le dernier battement de 11 min
    await db.update(agentJobs)
      .set({ lastHeartbeatAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(agentJobs.id, job.id));
    expect(await sweepSilentJobs(ws.workspaceId)).toBe(1);
    const after = await getJob(ws.workspaceId, job.id);
    expect(after!.status).toBe("failed");
    expect(after!.error).toMatch(/silencieux/);
    // listJobs balaie aussi : un second appel ne retrouve plus rien à basculer
    expect(await sweepSilentJobs(ws.workspaceId)).toBe(0);
  });

  it("listJobs : filtres, ordre, résumé de cible, balayage intégré", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Titre visible dans la liste" });
    const { job: j1 } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await new Promise((r) => setTimeout(r, 5));
    const { job: j2 } = await createJob(ws.workspaceId, { kind: "autre", targetType: "idea", targetId: idea.id });

    const asc = await listJobs(ws.workspaceId, { status: "queued", order: "asc" });
    expect(asc.map((j) => j.id)).toEqual([j1.id, j2.id]);
    expect(asc[0].targetTitle).toBe("Titre visible dans la liste");

    const desc = await listJobs(ws.workspaceId, { targetType: "idea", targetId: idea.id });
    expect(desc.map((j) => j.id)).toEqual([j2.id, j1.id]);

    expect(await listJobs(ws.workspaceId, { kind: "autre" })).toHaveLength(1);
    const autre = await signUpTestUser();
    expect(await listJobs(autre.workspaceId, {})).toHaveLength(0);
  });

  it("émet job.updated sur le bus à chaque transition, dans le bon workspace", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const seen: WorkspaceEvent[] = [];
    const un = bus.subscribe(ws.workspaceId, (e) => { if (e.type === "job.updated") seen.push(e); });
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    await completeJob(ws.workspaceId, job.id, {});
    un();
    expect(seen.map((e) => (e as { status: string }).status)).toEqual(["queued", "running", "done"]);
    expect((seen[0] as { jobId: string }).jobId).toBe(job.id);
  });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx vitest run tests/jobs.test.ts`
Expected: FAIL — `Cannot find module '@/lib/jobs'`.

- [ ] **Step 3: Ajouter le type d'événement**

Dans `src/lib/events.ts`, étendre `WorkspaceEvent` :

```ts
export type WorkspaceEvent =
  | { type: "content.updated"; contentId: string; revisionId: string; state: "current" | "proposed" }
  | { type: "content.status"; contentId: string; status: string }
  | { type: "idea.created"; ideaId: string }
  | { type: "lane.message"; laneId: string; event: LaneRunEvent }
  // vague « cockpit agent » : chaque transition d'un job (création incluse)
  | { type: "job.updated"; jobId: string; kind: string; targetType: "idea" | "content" | "comment"; targetId: string; status: string };
```

- [ ] **Step 4: Écrire la lib**

`src/lib/jobs.ts` :

```ts
import { and, asc, desc, eq, getTableColumns, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentJobs, contents, ideas } from "@/lib/db/schema";
import { bus } from "@/lib/events";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobTargetType = "idea" | "content" | "comment";
export type Job = typeof agentJobs.$inferSelect;

export const SILENT_AFTER_MS = 10 * 60_000;
export const MAX_JOB_ERROR_LENGTH = 2000;
export const MAX_JOB_JSON_BYTES = 64 * 1024;
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
 * Le cas `comment` est branché en Task 12 (table content_comments).
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
  }
  throw new Error("cible introuvable dans ce workspace");
}

export async function createJob(workspaceId: string, input: {
  kind: string; targetType: JobTargetType; targetId: string;
  payload?: Record<string, unknown>; requestedBy?: string; coalesce?: boolean;
}): Promise<{ job: Job; created: boolean }> {
  const kind = input.kind.trim();
  if (!kind) throw new Error("kind requis");
  if (kind.length > MAX_JOB_KIND_LENGTH) throw new Error(`kind trop long (max ${MAX_JOB_KIND_LENGTH} caractères)`);
  const payload = input.payload ?? {};
  if (jsonBytes(payload) > MAX_JOB_JSON_BYTES) throw new Error(`payload trop gros (max ${MAX_JOB_JSON_BYTES} octets)`);
  await assertTarget(workspaceId, input.targetType, input.targetId);

  const r = await db.transaction(async (tx) => {
    // Verrou consultatif par (workspace, kind, cible) le temps de la transaction :
    // deux créations simultanées (double clic, hook + bouton) ne peuvent pas
    // toutes deux conclure « aucun job actif » et insérer chacune le leur.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:${kind}:${input.targetId}`}))`);
    const active = await tx.select().from(agentJobs).where(and(
      eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.kind, kind),
      eq(agentJobs.targetType, input.targetType), eq(agentJobs.targetId, input.targetId),
      inArray(agentJobs.status, ["queued", "running"]),
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
  const limit = new Date(Date.now() - SILENT_AFTER_MS);
  const rows = await db.update(agentJobs)
    .set({ status: "failed", error: SILENT_ERROR, finishedAt: new Date() })
    .where(and(
      eq(agentJobs.workspaceId, workspaceId), eq(agentJobs.status, "running"),
      lt(sql`coalesce(${agentJobs.lastHeartbeatAt}, ${agentJobs.startedAt}, ${agentJobs.createdAt})`, limit),
    )).returning();
  rows.forEach(publish);
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
  if (jsonBytes(result) > MAX_JOB_JSON_BYTES) throw new Error(`result trop gros (max ${MAX_JOB_JSON_BYTES} octets)`);
  return finish(workspaceId, id, { status: "done", result });
  // Effets de complétion des kinds intégrés (transcribe → commentaire) : Task 12.
}

export async function failJob(workspaceId: string, id: string, error: string): Promise<Job | null> {
  const message = (error || "échec sans message").slice(0, MAX_JOB_ERROR_LENGTH);
  return finish(workspaceId, id, { status: "failed", error: message });
  // Effets d'échec des kinds intégrés (sync → publication.last_error, transcribe → commentaire) : Tasks 7 et 12.
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
  if (row) { publish(row); return row; }
  const existing = await getJob(workspaceId, id);
  if (!existing) return null;
  throw new JobStateError(`annulation refusée : job en statut ${existing.status}`);
}
```

- [ ] **Step 5: Lancer les tests**

Run: `npx vitest run tests/jobs.test.ts`
Expected: PASS (12 tests). Si le claim concurrent rend deux gagnants : vérifier que l'`UPDATE … WHERE status='queued'` est bien la seule écriture (pas de select-puis-update).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: 0 erreur.

```bash
git add src/lib/jobs.ts src/lib/events.ts tests/jobs.test.ts
git commit -m "feat(jobs): lib — création/unicité/coalescence, claim atomique, heartbeat, complete/fail, retry/cancel, silence"
```

---

### Task 3: Outils MCP jobs + `set_content_status` + `update_idea`

**Files:**
- Modify: `src/app/api/[transport]/route.ts`
- Test: `tests/mcp-jobs.test.ts`

**Interfaces:**
- Consumes: `listJobs, claimJob, heartbeatJob, completeJob, failJob, JobStateError` (Task 2), `setContentStatus` (contents.ts), `updateIdea` (ideas.ts).
- Produces: outils MCP `list_jobs(status?, kind?)`, `claim_job(job_id, worker_label)`, `heartbeat_job(job_id)`, `complete_job(job_id, result?)`, `fail_job(job_id, error)`, `set_content_status(content_id, status)`, `update_idea(idea_id, status?, notes?, tags?)`. Une erreur métier est rendue `json({ error })` (pas une exception MCP) — le worker lit `error` et décide.

- [ ] **Step 1: Écrire les tests**

`tests/mcp-jobs.test.ts` (copier `appelerOutil` de `tests/mcp-create-idea.test.ts` dans `tests/helpers.ts` sous le nom `callMcpTool` et l'exporter — remplacer l'usage local dans `mcp-create-idea.test.ts` par l'import, pour ne pas dupliquer) :

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea, getIdea } from "@/lib/ideas";
import { createContentDraft, getContent } from "@/lib/contents";
import { createJob, getJob } from "@/lib/jobs";

async function setup() {
  const ws = await signUpTestUser();
  const { token } = await generateMcpToken(ws.workspaceId, "worker-test");
  const idea = await createIdea(ws.workspaceId, { title: "Idée MCP" });
  return { ws, token, idea };
}

describe("MCP — jobs", () => {
  it("list_jobs rend les queued du workspace du token, plus anciens d'abord, avec le titre de la cible", async () => {
    const { ws, token, idea } = await setup();
    await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id, payload: { channel_key: "community" } });
    const r = await callMcpTool(token, "list_jobs", { status: "queued" });
    const jobs = JSON.parse(r.texte);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("write");
    expect(jobs[0].payload).toEqual({ channel_key: "community" });
    expect(jobs[0].targetTitle).toBe("Idée MCP");
  });

  it("claim → heartbeat → complete : transitions visibles ; second claim → error", async () => {
    const { ws, token, idea } = await setup();
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const c = JSON.parse((await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "mac-mini" })).texte);
    expect(c.status).toBe("running");
    expect(c.claimedBy).toBe("mac-mini");
    const again = JSON.parse((await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "autre" })).texte);
    expect(again.error).toMatch(/déjà pris/);
    const hb = JSON.parse((await callMcpTool(token, "heartbeat_job", { job_id: job.id })).texte);
    expect(hb.status).toBe("running");
    const done = JSON.parse((await callMcpTool(token, "complete_job", { job_id: job.id, result: { content_id: "x" } })).texte);
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ content_id: "x" });
  });

  it("fail_job pose failed + error", async () => {
    const { ws, token, idea } = await setup();
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "w" });
    const f = JSON.parse((await callMcpTool(token, "fail_job", { job_id: job.id, error: "timeout enquêteur" })).texte);
    expect(f.status).toBe("failed");
    expect(f.error).toBe("timeout enquêteur");
  });

  it("le token de B ne voit ni ne claim les jobs de A", async () => {
    const { ws, idea } = await setup();
    const b = await signUpTestUser();
    const { token: tokenB } = await generateMcpToken(b.workspaceId, "b");
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(JSON.parse((await callMcpTool(tokenB, "list_jobs", {})).texte)).toHaveLength(0);
    const r = JSON.parse((await callMcpTool(tokenB, "claim_job", { job_id: job.id, worker_label: "b" })).texte);
    expect(r.error).toMatch(/introuvable/);
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("queued");
  });

  it("set_content_status et update_idea : cloisonnés, effets réels", async () => {
    const { ws, token, idea } = await setup();
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const s = JSON.parse((await callMcpTool(token, "set_content_status", { content_id: contentId, status: "review" })).texte);
    expect(s.status).toBe("review");
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("review");
    const u = JSON.parse((await callMcpTool(token, "update_idea", { idea_id: idea.id, status: "done", tags: ["communaute"] })).texte);
    expect(u.status).toBe("done");
    expect((await getIdea(ws.workspaceId, idea.id))!.tags).toEqual(["communaute"]);

    const b = await signUpTestUser();
    const { token: tokenB } = await generateMcpToken(b.workspaceId, "b");
    const sb = JSON.parse((await callMcpTool(tokenB, "set_content_status", { content_id: contentId, status: "published" })).texte);
    expect(sb.error).toMatch(/introuvable/);
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("review");
    const ub = JSON.parse((await callMcpTool(tokenB, "update_idea", { idea_id: idea.id, status: "archived" })).texte);
    expect(ub.error).toMatch(/introuvable/);
  });
});
```

Ajout dans `tests/helpers.ts` :

```ts
import { NextRequest } from "next/server";
import { POST as mcpPOST } from "@/app/api/[transport]/route";

// Appelle un outil MCP à travers le vrai handler HTTP, avec un vrai Bearer :
// le chemin qu'emprunte un agent, auth et cloisonnement compris.
export async function callMcpTool(token: string, name: string, args: Record<string, unknown>) {
  const req = new NextRequest("http://localhost:3003/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
    }),
  });
  const res = await mcpPOST(req);
  const brut = await res.text();
  const ligne = brut.split("\n").filter((l) => l.startsWith("data: ")).pop() ?? "";
  const rpc = JSON.parse(ligne.slice("data: ".length));
  return { status: res.status, rpc, texte: rpc.result?.content?.[0]?.text as string };
}
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx vitest run tests/mcp-jobs.test.ts`
Expected: FAIL — les outils n'existent pas (`rpc.error` « Tool list_jobs not found », `texte` undefined).

- [ ] **Step 3: Enregistrer les outils**

Dans `src/app/api/[transport]/route.ts`, importer :

```ts
import { listJobs, claimJob, heartbeatJob, completeJob, failJob, JobStateError } from "@/lib/jobs";
import { setContentStatus } from "@/lib/contents";   // ajouter à l'import existant
import { updateIdea } from "@/lib/ideas";             // idem
```

et ajouter, après `register_asset` (à l'intérieur du callback `createMcpHandler`) :

```ts
    // ---- jobs : la file de travail du worker externe -----------------------
    // Une erreur métier (introuvable, transition refusée) est rendue en
    // `{ error }` : le worker la lit et décide, pas d'exception JSON-RPC.
    const jobOr = async (p: Promise<unknown>) => {
      try {
        const row = await p;
        return json(row ?? { error: "job introuvable dans ce workspace" });
      } catch (e) {
        if (e instanceof JobStateError) return json({ error: e.message, code: e.code });
        throw e;
      }
    };

    server.registerTool(
      "list_jobs",
      {
        description: "Les jobs du workspace (demandes posées par l'humain ou par l'outil), plus anciens d'abord. Sans filtre : tous. Un worker sonde `status: \"queued\"`, puis claim_job. Chaque job porte kind, target_type/target_id, payload, et targetTitle (résumé de la cible).",
        inputSchema: {
          status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
          kind: z.string().optional(),
        },
      },
      async ({ status, kind }, extra) =>
        json(await listJobs(wsOf(extra), { status, kind, order: "asc" }))
    );

    server.registerTool(
      "claim_job",
      {
        description: "Prend un job queued (atomique : un seul worker gagne). Rend le job en running, ou { error } s'il est déjà pris/terminé/introuvable. Pendant un travail long, appeler heartbeat_job toutes les 60 s : sans battement pendant 10 min, le job est basculé en failed.",
        inputSchema: { job_id: z.string().uuid(), worker_label: z.string().trim().min(1).max(64) },
      },
      async ({ job_id, worker_label }, extra) => jobOr(claimJob(wsOf(extra), job_id, worker_label))
    );

    server.registerTool(
      "heartbeat_job",
      { description: "Signale que le worker travaille toujours sur ce job (running).", inputSchema: { job_id: z.string().uuid() } },
      async ({ job_id }, extra) => jobOr(heartbeatJob(wsOf(extra), job_id))
    );

    server.registerTool(
      "complete_job",
      {
        description: "Termine un job running avec un résultat (ex. { content_id } pour write, { url } pour publish, { text } pour transcribe). Les statuts des cibles se posent à part (set_content_status, update_idea, link_publication…) — sauf transcribe, dont le texte est écrit dans le commentaire par l'outil.",
        inputSchema: { job_id: z.string().uuid(), result: z.record(z.string(), z.unknown()).optional() },
      },
      async ({ job_id, result }, extra) => jobOr(completeJob(wsOf(extra), job_id, result ?? {}))
    );

    server.registerTool(
      "fail_job",
      {
        description: "Échoue un job running avec un message lisible par l'humain (affiché tel quel dans l'UI, tronqué à 2000 caractères). Pas de réessai automatique : c'est le bouton de l'UI.",
        inputSchema: { job_id: z.string().uuid(), error: z.string().min(1) },
      },
      async ({ job_id, error }, extra) => jobOr(failJob(wsOf(extra), job_id, error))
    );

    server.registerTool(
      "set_content_status",
      {
        description: "Pose le statut d'un contenu (draft, review, approved, published, generating, rejected). Le worker s'en sert après write (review) et publish (published).",
        inputSchema: {
          content_id: z.string().uuid(),
          status: z.enum(["draft", "review", "approved", "published", "generating", "rejected"]),
        },
      },
      async ({ content_id, status }, extra) => {
        try {
          return json(await setContentStatus(wsOf(extra), content_id, status));
        } catch (e) {
          if (e instanceof Error && e.message.includes("introuvable")) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "update_idea",
      {
        description: "Met à jour une idée : statut (inbox, in_progress, done, archived), notes, tags. Les champs absents ne bougent pas.",
        inputSchema: {
          idea_id: z.string().uuid(),
          status: z.enum(["inbox", "in_progress", "done", "archived"]).optional(),
          notes: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      async ({ idea_id, status, notes, tags }, extra) => {
        const row = await updateIdea(wsOf(extra), idea_id, { status, notes, tags });
        return json(row ?? { error: "idée introuvable dans ce workspace" });
      }
    );
```

- [ ] **Step 4: Lancer les tests MCP (nouveaux + existants)**

Run: `npx vitest run tests/mcp-jobs.test.ts tests/mcp-create-idea.test.ts tests/mcp-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 erreur.

```bash
git add "src/app/api/[transport]/route.ts" tests/mcp-jobs.test.ts tests/helpers.ts tests/mcp-create-idea.test.ts
git commit -m "feat(mcp): outils jobs (list/claim/heartbeat/complete/fail) + set_content_status + update_idea"
```

---

### Task 4: Routes session `/api/jobs` (+ retry, cancel) avec effets des kinds intégrés

**Files:**
- Create: `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/retry/route.ts`, `src/app/api/jobs/[id]/cancel/route.ts`
- Modify: `tests/helpers.ts` (+ `sessionCookie`, `authedReq`, déplacés depuis `tests/workspace-settings.test.ts` qui les importe désormais)
- Test: `tests/jobs-routes.test.ts`

**Interfaces:**
- Consumes: `createJob, listJobs, retryJob, cancelJob, JobStateError` (Task 2), `updateIdea`, `setContentStatus`, `getContent`.
- Produces: `POST /api/jobs` `{kind, target_type, target_id, payload?, coalesce?}` → 201 `{job, created:true}` ou 200 `{job, created:false}` ; `GET /api/jobs?target_type=&target_id=` → `Job[]` (plus récents d'abord) ; `POST /api/jobs/:id/retry` → job ; `POST /api/jobs/:id/cancel` → job. Effets de création : `write` sur idée → idée `in_progress` (400 sans `payload.channel_key`) ; `publish` sur contenu → contenu `approved` (400 si corps vide).

- [ ] **Step 1: Déplacer les helpers de session**

Dans `tests/helpers.ts`, ajouter (copié de `tests/workspace-settings.test.ts`, puis supprimer les définitions locales là-bas et importer depuis `./helpers`) :

```ts
export type TestUser = Awaited<ReturnType<typeof signUpTestUser>>;

// Session RÉELLE via better-auth (jamais un cookie fabriqué à la main).
export async function sessionCookie(user: TestUser): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email: user.email, password: "motdepasse-solide-123" },
    asResponse: true,
  })) as Response;
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

export function req(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost:3003${url}`, init as never);
}

export async function authedReq(user: TestUser, url: string, init?: RequestInit) {
  const cookie = await sessionCookie(user);
  return req(url, { ...init, headers: { ...(init?.headers ?? {}), cookie } });
}
```

Run: `npx vitest run tests/workspace-settings.test.ts` → PASS (rien ne change fonctionnellement).

- [ ] **Step 2: Écrire les tests des routes**

`tests/jobs-routes.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { POST as createRoute, GET as listRoute } from "@/app/api/jobs/route";
import { POST as retryRoute } from "@/app/api/jobs/[id]/retry/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { createIdea, getIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate, getContent } from "@/lib/contents";
import { claimJob, failJob } from "@/lib/jobs";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("routes /api/jobs", () => {
  it("POST/GET sans session → 401", async () => {
    expect((await createRoute(req("/api/jobs", jsonInit({ kind: "write" })))).status).toBe(401);
    expect((await listRoute(req("/api/jobs?target_type=idea&target_id=x"))).status).toBe(401);
  });

  it("POST write sur une idée : 201, job queued, idée in_progress ; second POST → 200 + created:false", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "À rédiger" });
    const r1 = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r1.status).toBe(201);
    const { job, created } = await r1.json();
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.requestedBy).toBe(`user:${ws.userId}`);
    expect((await getIdea(ws.workspaceId, idea.id))!.status).toBe("in_progress");

    const r2 = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r2.status).toBe(200);
    expect((await r2.json()).created).toBe(false);
  });

  it("POST write sans channel_key → 400 ; cible d'un autre workspace → 404", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const r = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id })));
    expect(r.status).toBe(400);
    const b = await signUpTestUser();
    const r404 = await createRoute(await authedReq(b, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r404.status).toBe(404);
  });

  it("POST publish : corps vide → 400 ; corps non vide → contenu approved", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const vide = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "publish", target_type: "content", target_id: contentId })));
    expect(vide.status).toBe(400);
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# Titre\n\nCorps.", authorType: "user" });
    const ok = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "publish", target_type: "content", target_id: contentId })));
    expect(ok.status).toBe(201);
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("approved");
  });

  it("GET par cible rend les jobs, plus récents d'abord", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })));
    await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "autre", target_type: "idea", target_id: idea.id })));
    const r = await listRoute(await authedReq(ws, `/api/jobs?target_type=idea&target_id=${idea.id}`));
    expect(r.status).toBe(200);
    const jobs = await r.json();
    expect(jobs.map((j: { kind: string }) => j.kind)).toEqual(["autre", "write"]);
  });

  it("retry : failed → queued (200) ; queued → 409 ; autre workspace → 404", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { job } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    expect((await retryRoute(await authedReq(ws, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id))).status).toBe(409);
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const ok = await retryRoute(await authedReq(ws, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("queued");
    const b = await signUpTestUser();
    expect((await retryRoute(await authedReq(b, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id))).status).toBe(404);
  });

  it("cancel : queued → cancelled (200) ; running → 409", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { job } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    const ok = await cancelRoute(await authedReq(ws, `/api/jobs/${job.id}/cancel`, { method: "POST" }), params(job.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("cancelled");
    const { job: j2 } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    await claimJob(ws.workspaceId, j2.id, "w");
    expect((await cancelRoute(await authedReq(ws, `/api/jobs/${j2.id}/cancel`, { method: "POST" }), params(j2.id))).status).toBe(409);
  });
});
```

- [ ] **Step 3: Lancer, vérifier l'échec**

Run: `npx vitest run tests/jobs-routes.test.ts`
Expected: FAIL — modules de routes introuvables.

- [ ] **Step 4: Écrire les routes**

`src/app/api/jobs/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createJob, listJobs, type JobStatus, type JobTargetType } from "@/lib/jobs";
import { updateIdea } from "@/lib/ideas";
import { getContent, setContentStatus } from "@/lib/contents";

const TARGET_TYPES = ["idea", "content", "comment"] as const;
const STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const sp = req.nextUrl.searchParams;
    const targetType = sp.get("target_type") ?? undefined;
    const status = sp.get("status") ?? undefined;
    if (targetType && !TARGET_TYPES.includes(targetType as never))
      return NextResponse.json({ error: "target_type invalide" }, { status: 400 });
    if (status && !STATUSES.includes(status as never))
      return NextResponse.json({ error: "status invalide" }, { status: 400 });
    return NextResponse.json(await listJobs(workspaceId, {
      targetType: targetType as JobTargetType | undefined,
      targetId: sp.get("target_id") ?? undefined,
      kind: sp.get("kind") ?? undefined,
      status: status as JobStatus | undefined,
    }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

/**
 * Création par l'UI. Effets des kinds intégrés (documentés dans la spec §1.4,
 * volontairement ICI et pas dans la lib : ce sont des conventions d'interface,
 * pas des règles du modèle) : write → idée in_progress ; publish → contenu
 * approved. Tout autre kind est accepté tel quel.
 */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "corps invalide" }, { status: 400 }); }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return NextResponse.json({ error: "corps invalide" }, { status: 400 });
    const { kind, target_type, target_id, payload, coalesce } = body;
    if (typeof kind !== "string" || !kind.trim())
      return NextResponse.json({ error: "kind requis" }, { status: 400 });
    if (!TARGET_TYPES.includes(target_type as never) || typeof target_id !== "string")
      return NextResponse.json({ error: "target_type et target_id requis" }, { status: 400 });
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload)))
      return NextResponse.json({ error: "payload doit être un objet" }, { status: 400 });
    const p = (payload ?? {}) as Record<string, unknown>;

    if (kind === "write" && typeof p.channel_key !== "string")
      return NextResponse.json({ error: "payload.channel_key requis pour write" }, { status: 400 });
    if (kind === "publish") {
      if (target_type !== "content") return NextResponse.json({ error: "publish vise un contenu" }, { status: 400 });
      const c = await getContent(workspaceId, target_id);
      if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!c.body.trim()) return NextResponse.json({ error: "corps vide : rien à publier" }, { status: 400 });
    }

    const r = await createJob(workspaceId, {
      kind, targetType: target_type as JobTargetType, targetId: target_id,
      payload: p, requestedBy: `user:${userId}`, coalesce: coalesce === true,
    });
    if (r.created) {
      if (kind === "write" && target_type === "idea") await updateIdea(workspaceId, target_id, { status: "in_progress" });
      if (kind === "publish") await setContentStatus(workspaceId, target_id, "approved");
    }
    return NextResponse.json(r, { status: r.created ? 201 : 200 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable"))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && (e.message.includes("requis") || e.message.includes("trop")))
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

`src/app/api/jobs/[id]/retry/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { retryJob, JobStateError } from "@/lib/jobs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const job = await retryJob(workspaceId, (await params).id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(job);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof JobStateError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
```

`src/app/api/jobs/[id]/cancel/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { cancelJob, JobStateError } from "@/lib/jobs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const job = await cancelJob(workspaceId, (await params).id);
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(job);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof JobStateError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
```

- [ ] **Step 5: Lancer les tests**

Run: `npx vitest run tests/jobs-routes.test.ts tests/workspace-settings.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/app/api/jobs tests/jobs-routes.test.ts tests/helpers.ts tests/workspace-settings.test.ts
git commit -m "feat(jobs): routes session POST/GET /api/jobs + retry/cancel, effets write→in_progress et publish→approved"
```

---

### Task 5: UI jobs — « Rédiger » (idée), « Publier » (contenu), pastille inbox, badge temps réel

**Files:**
- Create: `src/hooks/use-jobs.ts`, `src/components/cockpit/job-status.tsx`
- Modify: `src/components/cockpit/status-badge.tsx`, `src/lib/ideas.ts` (`lastJobStatus`), `src/app/(app)/ideas/[id]/page.tsx`, `src/app/(app)/contents/[id]/page.tsx`, `src/app/(app)/page.tsx`
- Test: `tests/ideas.test.ts` (ajout `lastJobStatus`)

**Interfaces:**
- Consumes: `GET/POST /api/jobs`, `/api/jobs/:id/retry|cancel` (Task 4), `useWorkspaceEvents` (événement `job.updated`).
- Produces: hook `useJobs(targetType, targetId) → { jobs, latest, refresh, create(kind, payload?), retry(id), cancel(id), error }` ; composant `<JobStatus targetType targetId kind label />` ; `listIdeas` rend en plus `lastJobStatus: string | null`.

- [ ] **Step 1: Test lib — `lastJobStatus` dans `listIdeas`**

Ajouter à `tests/ideas.test.ts` :

```ts
import { createJob } from "@/lib/jobs";
// …
it("listIdeas expose lastJobStatus (dernier job visant l'idée) — null sans job", async () => {
  const ws = await signUpTestUser();
  const idea = await createIdea(ws.workspaceId, { title: "Avec job" });
  const sans = await createIdea(ws.workspaceId, { title: "Sans job" });
  await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id, payload: { channel_key: "community" } });
  const rows = await listIdeas(ws.workspaceId);
  expect(rows.find((r) => r.id === idea.id)!.lastJobStatus).toBe("queued");
  expect(rows.find((r) => r.id === sans.id)!.lastJobStatus).toBeNull();
});
```

Run: `npx vitest run tests/ideas.test.ts` → FAIL (`lastJobStatus` undefined).

- [ ] **Step 2: Étendre `listIdeas`**

Dans `src/lib/ideas.ts`, ajouter au `select` de `listIdeas` (même pattern qualifié à la main) :

```ts
      lastJobStatus: sql<string | null>`(select j.status from agent_jobs j where j.target_type = 'idea' and j.target_id = ideas.id order by j.created_at desc limit 1)`,
```

Run: `npx vitest run tests/ideas.test.ts` → PASS.

- [ ] **Step 3: Teintes des statuts de job**

Dans `src/components/cockpit/status-badge.tsx`, étendre `VALUE_TONE` (section `// jobs`) et le type `kind` :

```ts
  // jobs (vague cockpit agent)
  queued: "muted",
  running: "accent",
  done: "success",
  cancelled: "muted",
  // failed / error déjà définis (danger)
```
et `kind: "idea" | "content" | "source" | "gauge" | "job"`.

- [ ] **Step 4: Hook `useJobs`**

`src/hooks/use-jobs.ts` :

```ts
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export type JobRow = {
  id: string; kind: string; status: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: Record<string, unknown>; result: Record<string, unknown>; error: string | null;
  attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
};

/**
 * Les jobs d'une cible, tenus à jour par SSE (job.updated) — jamais de polling.
 * `latest(kind)` = le plus récent de ce kind (la liste arrive plus récents d'abord).
 */
export function useJobs(targetType: "idea" | "content" | "comment", targetId: string) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/jobs?target_type=${targetType}&target_id=${targetId}`);
    if (res.ok) setJobs(await res.json());
  }, [targetType, targetId]);
  useEffect(() => { refresh(); }, [refresh]);
  useWorkspaceEvents((e) => {
    if (e.type === "job.updated" && e.targetType === targetType && e.targetId === targetId) refresh();
  });

  const create = useCallback(async (kind: string, payload?: Record<string, unknown>) => {
    setError(null);
    const res = await fetch("/api/jobs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, target_type: targetType, target_id: targetId, payload }),
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Échec de la demande. Réessaie.");
      return null;
    }
    await refresh();
    return (await res.json()).job as JobRow;
  }, [targetType, targetId, refresh]);

  const act = useCallback(async (id: string, action: "retry" | "cancel") => {
    setError(null);
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? `Échec (${action}). Réessaie.`);
    }
    await refresh();
  }, [refresh]);

  const latest = useCallback((kind: string) => jobs.find((j) => j.kind === kind) ?? null, [jobs]);
  const api = useMemo(() => ({
    jobs, latest, refresh, create, error,
    retry: (id: string) => act(id, "retry"),
    cancel: (id: string) => act(id, "cancel"),
  }), [jobs, latest, refresh, create, error, act]);
  return api;
}
```

- [ ] **Step 5: Composant `JobStatus`**

`src/components/cockpit/job-status.tsx` — affiche l'état du dernier job d'un kind pour une cible, avec Réessayer/Annuler, et un rendu spécial `done` (lien) fourni par le parent :

```tsx
"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/status-badge";
import type { JobRow } from "@/hooks/use-jobs";

const WAITING_AGENT_AFTER_MS = 2 * 60_000;

function elapsed(from: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

export function JobStatus({ job, onRetry, onCancel, renderDone }: {
  job: JobRow | null;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  renderDone?: (job: JobRow) => React.ReactNode;
}) {
  // re-rendu toutes les 15 s pour « En cours… depuis N » et « en attente d'un agent »
  const [, tick] = useState(0);
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [job]);
  if (!job) return null;

  if (job.status === "queued") {
    const waiting = Date.now() - new Date(job.createdAt).getTime() > WAITING_AGENT_AFTER_MS;
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="queued" className="animate-pulse" />
        {waiting ? "En attente d'un agent…" : "Demande enregistrée"}
        <Button variant="outline" onClick={() => onCancel(job.id)}>Annuler</Button>
      </span>
    );
  }
  if (job.status === "running") {
    return (
      <span className="flex items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="running" className="animate-pulse" />
        En cours… depuis {elapsed(job.startedAt ?? job.createdAt)}
      </span>
    );
  }
  if (job.status === "failed") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge kind="job" value="failed" />
        <span className="text-danger">Échec : {job.error}</span>
        <Button variant="outline" onClick={() => onRetry(job.id)}>Réessayer</Button>
      </span>
    );
  }
  if (job.status === "done") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="done" />
        {renderDone ? renderDone(job) : "Terminé"}
      </span>
    );
  }
  return <StatusBadge kind="job" value={job.status} />;
}
```

- [ ] **Step 6: Page idée — bouton « Rédiger » + sélecteur de canal**

Dans `src/app/(app)/ideas/[id]/page.tsx` : importer `useJobs` et `JobStatus` ; dans le composant, après les `useState` :

```tsx
  const jobs = useJobs("idea", id);
  const writeJob = jobs.latest("write");
  const writeActive = writeJob?.status === "queued" || writeJob?.status === "running";
  const [writeChannel, setWriteChannel] = useState<string>("");
  // canal par défaut : le dernier choisi dans ce navigateur, sinon le premier
  useEffect(() => {
    if (!channels.length || writeChannel) return;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem("cs.writeChannel"); } catch { /* stockage indisponible */ }
    setWriteChannel(channels.some((c) => c.key === remembered) ? remembered! : channels[0].key);
  }, [channels, writeChannel]);

  async function requestWrite() {
    try { localStorage.setItem("cs.writeChannel", writeChannel); } catch { /* ignoré */ }
    await jobs.create("write", { channel_key: writeChannel });
    load(); // l'idée passe in_progress
  }
```

et, AVANT la `SectionCard` « Décliner sur un canal », une nouvelle carte :

```tsx
      <SectionCard title="Rédiger avec l'agent">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={writeChannel}
            onChange={(e) => setWriteChannel(e.target.value)}
            disabled={writeActive || channels.length === 0}
            className="rounded-lg border border-line bg-raised px-2 py-1.5 text-sm"
          >
            {channels.map((c) => <option key={c.id} value={c.key}>{c.name}</option>)}
          </select>
          <Button onClick={requestWrite} disabled={writeActive || !writeChannel}>Rédiger</Button>
          <JobStatus
            job={writeJob}
            onRetry={jobs.retry}
            onCancel={jobs.cancel}
            renderDone={(j) => {
              const cid = typeof j.result.content_id === "string" ? j.result.content_id : null;
              return cid ? <a className="underline" href={`/contents/${cid}`}>Brouillon prêt → ouvrir</a> : "Terminé";
            }}
          />
        </div>
        {jobs.error && <p className="mt-2 text-sm text-danger">{jobs.error}</p>}
        <p className="mt-2 text-xs text-faint">
          Un worker branché en MCP prend la demande, enquête, rédige, et dépose un brouillon en relecture.
        </p>
      </SectionCard>
```

- [ ] **Step 7: Page contenu — bouton « Publier »**

Dans `src/app/(app)/contents/[id]/page.tsx` : importer `useJobs`, `JobStatus` ; ajouter `const jobs = useJobs("content", id); const publishJob = jobs.latest("publish"); const publishActive = publishJob?.status === "queued" || publishJob?.status === "running";` ; dans la barre d'actions (à côté de `ExportButton`) :

```tsx
          <button
            type="button"
            disabled={publishActive || !content.body.trim()}
            onClick={async () => { await jobs.create("publish"); load(); }}
            className="rounded-full border border-accent/40 bg-accent-soft px-2.5 py-1 text-[11px] font-medium tracking-wider text-accent uppercase transition-colors duration-150 hover:border-accent disabled:opacity-50"
          >
            Publier
          </button>
```

et sous la barre (avant `{error && …}`) :

```tsx
      <JobStatus
        job={publishJob} onRetry={jobs.retry} onCancel={jobs.cancel}
        renderDone={(j) => typeof j.result.url === "string"
          ? <a className="underline" href={j.result.url} target="_blank" rel="noreferrer">Publié → voir</a>
          : "Publié"}
      />
      {jobs.error && <p className="text-sm text-danger">{jobs.error}</p>}
```

- [ ] **Step 8: Inbox — pastille du dernier job**

Dans `src/app/(app)/page.tsx`, ajouter `lastJobStatus: string | null` au type `Idea`, et dans la carte, à côté du `StatusBadge` idée :

```tsx
                {i.lastJobStatus && (
                  <StatusBadge kind="job" value={i.lastJobStatus}
                    className={i.lastJobStatus === "running" || i.lastJobStatus === "queued" ? "animate-pulse" : undefined} />
                )}
```

et rafraîchir la liste sur `job.updated` : ajouter `useWorkspaceEvents((e) => { if (e.type === "job.updated" || e.type === "idea.created") load(); });` (la page a déjà un `load` qui fetch `/api/ideas` ; l'importer depuis `@/hooks/use-workspace-events`).

- [ ] **Step 9: Vérifier**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 erreur. Puis `npm run dev` et, dans le navigateur (`http://127.0.0.1:3003`) : créer une idée → « Rédiger » → badge « Demande enregistrée » (queued) ; dans un terminal, simuler le worker :

```bash
# token : Réglages → Tokens MCP ; JOB_ID : visible dans la réponse list_jobs
curl -s http://127.0.0.1:3003/api/mcp -H "authorization: Bearer cs_…" -H "content-type: application/json" -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_jobs","arguments":{"status":"queued"}}}'
# puis claim_job / complete_job de la même façon → le badge passe running puis done SANS recharger la page
```

Vérifier aussi : « Publier » désactivé sur un contenu vide ; Réessayer visible après un `fail_job`.

- [ ] **Step 10: Commit**

```bash
git add src/hooks/use-jobs.ts src/components/cockpit/job-status.tsx src/components/cockpit/status-badge.tsx src/lib/ideas.ts "src/app/(app)/ideas/[id]/page.tsx" "src/app/(app)/contents/[id]/page.tsx" "src/app/(app)/page.tsx" tests/ideas.test.ts
git commit -m "feat(jobs): UI — Rédiger (idée, canal mémorisé), Publier (contenu), pastille inbox, états temps réel via SSE"
```

---

# Partie 2 — Publications

### Task 6: Table `publications` + migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0005_*.sql`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Test**

```ts
it("la table publications existe (Task 6)", async () => {
  expect(await tableNames()).toContain("publications");
});
```
Run: `npx vitest run tests/schema.test.ts` → FAIL.

- [ ] **Step 2: Schéma**

Après `agentJobs` :

```ts
// ---- publications ---------------------------------------------------------
// Le lien entre un contenu du studio et l'objet publié ailleurs par un
// worker (target libre : 'fluentcommunity', 'wordpress', …). Sert à afficher
// « publié ici », à détecter « modifié depuis » (hash du corps publié) et à
// demander une re-synchronisation (job sync, créé par applyContentUpdate).
export const publications = pgTable("publications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  contentId: uuid("content_id").notNull()
    .references(() => contents.id, { onDelete: "cascade" }),
  target: text("target").notNull(),
  externalId: text("external_id").notNull(),
  url: text("url").notNull().default(""),
  meta: jsonb("meta").notNull().default({}),
  publishedBodyHash: text("published_body_hash").notNull().default(""),
  publishedAt: timestamp("published_at"),
  syncedAt: timestamp("synced_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("publications_content_target").on(t.contentId, t.target),
  index("publications_ws_target").on(t.workspaceId, t.target),
]);
```

- [ ] **Step 3: Migration + test + commit**

```bash
DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npx drizzle-kit generate
npx vitest run tests/schema.test.ts
git add src/lib/db/schema.ts drizzle/ tests/schema.test.ts
git commit -m "feat(publications): table publications — lien contenu ↔ objet publié, hash du corps publié"
```

---

### Task 7: Lib `publications.ts` + hook « publié puis modifié → job sync » + effet d'échec

**Files:**
- Create: `src/lib/publications.ts`
- Modify: `src/lib/contents.ts` (`applyContentUpdate`, `resolveProposed`), `src/lib/jobs.ts` (`failJob` → `last_error`)
- Test: `tests/publications.test.ts`

**Interfaces:**
- Produces :
  - `bodyHash(body: string) → string` (sha256 hex)
  - `listPublications(workspaceId, { target?, contentId? }) → Publication[]`
  - `linkPublication(workspaceId, { contentId, target, externalId, url?, meta?, bodyHash }) → Publication` (upsert `(contentId, target)`)
  - `markSynced(workspaceId, publicationId, bodyHash) → Publication | null`
  - `setPublicationError(workspaceId, publicationId, error) → Publication | null`
  - `enqueueSyncIfStale(workspaceId, contentId, body) → Promise<number>` (nombre de jobs créés) — appelé par `contents.ts` après toute révision devenue courante.

- [ ] **Step 1: Tests**

`tests/publications.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate, resolveProposed, heartbeatEditing } from "@/lib/contents";
import { listJobs, claimJob, failJob } from "@/lib/jobs";
import {
  bodyHash, listPublications, linkPublication, markSynced, setPublicationError,
} from "@/lib/publications";

async function contentIn(ws: { workspaceId: string }, body = "# T\n\ncorps") {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body, authorType: "user" });
  return contentId;
}

describe("publications — lib", () => {
  it("linkPublication upsert sur (content, target) ; listPublications filtre ; cloisonnement", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const p1 = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "42", url: "https://c.test/post/42", meta: { space: "actus-ia" }, bodyHash: bodyHash("# T\n\ncorps") });
    expect(p1.publishedAt).not.toBeNull();
    expect(p1.syncedAt).not.toBeNull();
    const p2 = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "42", url: "https://c.test/post/42-bis", bodyHash: "h2" });
    expect(p2.id).toBe(p1.id);
    expect(p2.url).toBe("https://c.test/post/42-bis");
    expect(p2.publishedAt!.getTime()).toBe(p1.publishedAt!.getTime());
    expect(await listPublications(ws.workspaceId, { contentId })).toHaveLength(1);
    expect(await listPublications(ws.workspaceId, { target: "autre" })).toHaveLength(0);
    const b = await signUpTestUser();
    expect(await listPublications(b.workspaceId, {})).toHaveLength(0);
    await expect(linkPublication(b.workspaceId, { contentId, target: "x", externalId: "1", bodyHash: "h" })).rejects.toThrow(/introuvable/);
  });

  it("markSynced met à jour hash + syncedAt et efface last_error ; setPublicationError pose last_error", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: "h1" });
    const err = await setPublicationError(ws.workspaceId, p.id, "403 depuis la cible");
    expect(err!.lastError).toBe("403 depuis la cible");
    const ok = await markSynced(ws.workspaceId, p.id, "h2");
    expect(ok!.publishedBodyHash).toBe("h2");
    expect(ok!.lastError).toBeNull();
    const b = await signUpTestUser();
    expect(await markSynced(b.workspaceId, p.id, "h3")).toBeNull();
  });
});

describe("publications — hook « publié puis modifié »", () => {
  it("révision courante sur un contenu publié au hash différent → UN job sync coalescé ; révision identique au hash → aucun", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: bodyHash("# T\n\nv1") });
    // même corps : rien
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv1", authorType: "user" });
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(0);
    // rafale d'autosauvegardes : un seul queued
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv2", authorType: "user" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv3", authorType: "user" });
    const syncs = await listJobs(ws.workspaceId, { kind: "sync" });
    expect(syncs).toHaveLength(1);
    expect(syncs[0].payload).toEqual({ publication_id: p.id, target: "fluentcommunity" });
    expect(syncs[0].requestedBy).toBe("system:publication-sync");
    // un sync running + nouvelle édition → un second queued (rattrapage)
    await claimJob(ws.workspaceId, syncs[0].id, "w");
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv4", authorType: "user" });
    expect(await listJobs(ws.workspaceId, { kind: "sync", status: "queued" })).toHaveLength(1);
  });

  it("une révision proposed (agent pendant édition humaine) ne crée rien ; son acceptation, si", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: bodyHash("# T\n\nv1") });
    await heartbeatEditing(ws.workspaceId, contentId); // l'humain édite → écriture agent = proposed
    const r = await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nagent", authorType: "agent" });
    expect(r.state).toBe("proposed");
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(0);
    const current = (await listJobs(ws.workspaceId, {})); // juste pour forcer un balayage, sans effet attendu
    expect(current).toHaveLength(0);
    const { getContent } = await import("@/lib/contents");
    const c = await getContent(ws.workspaceId, contentId);
    await resolveProposed({ workspaceId: ws.workspaceId, contentId, revisionId: r.revisionId, action: "accept", expectedCurrentRevisionId: c!.currentRevisionId });
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(1);
  });

  it("fail_job d'un sync pose last_error sur la publication du payload", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: "autre" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv2", authorType: "user" });
    const [job] = await listJobs(ws.workspaceId, { kind: "sync" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "FluentCommunity 500");
    const [pub] = await listPublications(ws.workspaceId, { contentId });
    expect(pub.lastError).toBe("FluentCommunity 500");
    expect(pub.id).toBe(p.id);
  });
});
```

- [ ] **Step 2: Lancer → FAIL** (`@/lib/publications` introuvable).

- [ ] **Step 3: Écrire la lib**

`src/lib/publications.ts` :

```ts
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents, publications } from "@/lib/db/schema";
import { createJob } from "@/lib/jobs";

export type Publication = typeof publications.$inferSelect;
export const MAX_PUBLICATION_ERROR_LENGTH = 2000;

/** Empreinte du corps markdown tel que publié — la même côté worker (sha256 hex, utf8). */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function listPublications(workspaceId: string, filter: { target?: string; contentId?: string }) {
  const conds = [eq(publications.workspaceId, workspaceId)];
  if (filter.target) conds.push(eq(publications.target, filter.target));
  if (filter.contentId) conds.push(eq(publications.contentId, filter.contentId));
  return db.select().from(publications).where(and(...conds)).orderBy(desc(publications.createdAt));
}

export async function linkPublication(workspaceId: string, input: {
  contentId: string; target: string; externalId: string; url?: string;
  meta?: Record<string, unknown>; bodyHash: string;
}): Promise<Publication> {
  const [content] = await db.select({ id: contents.id }).from(contents)
    .where(and(eq(contents.id, input.contentId), eq(contents.workspaceId, workspaceId)));
  if (!content) throw new Error("content introuvable dans ce workspace");
  const target = input.target.trim();
  if (!target) throw new Error("target requis");
  if (!input.externalId.trim()) throw new Error("external_id requis");
  const now = new Date();
  const [row] = await db.insert(publications).values({
    workspaceId, contentId: input.contentId, target, externalId: input.externalId,
    url: input.url ?? "", meta: input.meta ?? {}, publishedBodyHash: input.bodyHash,
    publishedAt: now, syncedAt: now, lastError: null,
  }).onConflictDoUpdate({
    target: [publications.contentId, publications.target],
    set: {
      externalId: input.externalId, url: input.url ?? "", meta: input.meta ?? {},
      publishedBodyHash: input.bodyHash, syncedAt: now, lastError: null, updatedAt: now,
    },
  }).returning();
  return row;
}

export async function markSynced(workspaceId: string, publicationId: string, hash: string) {
  const [row] = await db.update(publications)
    .set({ publishedBodyHash: hash, syncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(publications.id, publicationId), eq(publications.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

export async function setPublicationError(workspaceId: string, publicationId: string, error: string) {
  const [row] = await db.update(publications)
    .set({ lastError: error.slice(0, MAX_PUBLICATION_ERROR_LENGTH), updatedAt: new Date() })
    .where(and(eq(publications.id, publicationId), eq(publications.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/**
 * Hook « publié puis modifié » (spec §2.3) : pour chaque publication du contenu
 * dont le hash publié diffère du corps courant, un job `sync` coalescé. Appelé
 * par contents.ts APRÈS qu'une révision est devenue courante — jamais pour une
 * proposed. Idempotent : corps identique au publié → rien.
 */
export async function enqueueSyncIfStale(workspaceId: string, contentId: string, body: string): Promise<number> {
  const pubs = await listPublications(workspaceId, { contentId });
  const hash = bodyHash(body);
  let created = 0;
  for (const p of pubs) {
    if (p.publishedBodyHash === hash) continue;
    const r = await createJob(workspaceId, {
      kind: "sync", targetType: "content", targetId: contentId,
      payload: { publication_id: p.id, target: p.target },
      requestedBy: "system:publication-sync", coalesce: true,
    });
    if (r.created) created++;
  }
  return created;
}
```

- [ ] **Step 4: Brancher le hook dans `contents.ts`**

Dans `applyContentUpdate`, après `bus.publish(...)` et avant `return result;` :

```ts
  if (result.state === "current") await enqueueSyncIfStale(p.workspaceId, p.contentId, p.body);
```

Dans `resolveProposed`, après le `bus.publish` final (accept) : relire le corps et appeler le hook :

```ts
  const [fresh] = await db.select({ body: contents.body }).from(contents).where(eq(contents.id, p.contentId));
  if (fresh) await enqueueSyncIfStale(p.workspaceId, p.contentId, fresh.body);
```

Import : `import { enqueueSyncIfStale } from "@/lib/publications";` (pas de cycle : publications.ts importe jobs.ts, jamais contents.ts).

- [ ] **Step 5: Effet d'échec dans `failJob`**

Dans `src/lib/jobs.ts`, `failJob` devient :

```ts
export async function failJob(workspaceId: string, id: string, error: string): Promise<Job | null> {
  const message = (error || "échec sans message").slice(0, MAX_JOB_ERROR_LENGTH);
  const row = await finish(workspaceId, id, { status: "failed", error: message });
  if (row) await applyFailureEffects(row, message);
  return row;
}

/** Effets d'échec des kinds intégrés (spec §1.4 / §2.2). */
async function applyFailureEffects(job: Job, message: string) {
  const payload = job.payload as Record<string, unknown>;
  if (job.kind === "sync" && typeof payload.publication_id === "string") {
    const { setPublicationError } = await import("@/lib/publications");
    await setPublicationError(job.workspaceId, payload.publication_id, message);
  }
}
```

(import dynamique : `publications.ts` importe `jobs.ts` pour `createJob` — l'import statique inverse ferait un cycle au chargement des modules.)

- [ ] **Step 6: Lancer les tests**

Run: `npx vitest run tests/publications.test.ts tests/contents-revisions.test.ts tests/jobs.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/lib/publications.ts src/lib/contents.ts src/lib/jobs.ts tests/publications.test.ts
git commit -m "feat(publications): lib + hook « publié puis modifié → job sync coalescé » + last_error sur échec de sync"
```

---

### Task 8: Outils MCP publications

**Files:**
- Modify: `src/app/api/[transport]/route.ts`
- Test: `tests/mcp-publications.test.ts`

**Interfaces:**
- Produces: `list_publications(target?, content_id?)`, `link_publication(content_id, target, external_id, url?, meta?, body_hash)`, `mark_synced(publication_id, body_hash)`.

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { listPublications, bodyHash } from "@/lib/publications";

describe("MCP — publications", () => {
  it("link_publication crée/upsert, list_publications filtre, mark_synced met à jour ; cloisonnés", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const idea = await createIdea(ws.workspaceId, { title: "I" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv1", authorType: "user" });

    const linked = JSON.parse((await callMcpTool(token, "link_publication", {
      content_id: contentId, target: "fluentcommunity", external_id: "77",
      url: "https://c.test/post/77", meta: { space: "actus-ia" }, body_hash: bodyHash("# T\n\nv1"),
    })).texte);
    expect(linked.externalId).toBe("77");
    const list = JSON.parse((await callMcpTool(token, "list_publications", { target: "fluentcommunity" })).texte);
    expect(list).toHaveLength(1);
    expect(list[0].contentId).toBe(contentId);
    const synced = JSON.parse((await callMcpTool(token, "mark_synced", { publication_id: linked.id, body_hash: "h2" })).texte);
    expect(synced.publishedBodyHash).toBe("h2");

    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect(JSON.parse((await callMcpTool(tb, "list_publications", {})).texte)).toHaveLength(0);
    expect(JSON.parse((await callMcpTool(tb, "mark_synced", { publication_id: linked.id, body_hash: "x" })).texte).error).toMatch(/introuvable/);
    expect(JSON.parse((await callMcpTool(tb, "link_publication", { content_id: contentId, target: "t", external_id: "1", body_hash: "h" })).texte).error).toMatch(/introuvable/);
    expect((await listPublications(ws.workspaceId, { contentId }))[0].publishedBodyHash).toBe("h2");
  });
});
```

Run: `npx vitest run tests/mcp-publications.test.ts` → FAIL.

- [ ] **Step 2: Outils**

Dans `route.ts`, importer `{ listPublications, linkPublication, markSynced }` de `@/lib/publications` et enregistrer :

```ts
    // ---- publications : le lien vers l'objet publié par le worker --------------
    server.registerTool(
      "list_publications",
      {
        description: "Les publications du workspace (lien contenu ↔ objet publié sur une cible externe : external_id, url, hash du corps publié, synced_at, last_error). Filtres : target, content_id. Un worker s'en sert pour l'import (« ce feed est-il déjà lié ? ») et le sync (« quel external_id ? »).",
        inputSchema: { target: z.string().optional(), content_id: z.string().uuid().optional() },
      },
      async ({ target, content_id }, extra) => json(await listPublications(wsOf(extra), { target, contentId: content_id }))
    );
    server.registerTool(
      "link_publication",
      {
        description: "Déclare (ou met à jour) qu'un contenu est publié sur une cible : target (ex. fluentcommunity), external_id, url, meta, body_hash = sha256 hex du corps markdown tel que publié. Upsert sur (content, target). À appeler juste après une publication réussie.",
        inputSchema: {
          content_id: z.string().uuid(), target: z.string().trim().min(1), external_id: z.string().trim().min(1),
          url: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(), body_hash: z.string().min(1),
        },
      },
      async ({ content_id, target, external_id, url, meta, body_hash }, extra) => {
        try {
          return json(await linkPublication(wsOf(extra), { contentId: content_id, target, externalId: external_id, url, meta, bodyHash: body_hash }));
        } catch (e) {
          if (e instanceof Error && (e.message.includes("introuvable") || e.message.includes("requis"))) return json({ error: e.message });
          throw e;
        }
      }
    );
    server.registerTool(
      "mark_synced",
      {
        description: "Après un sync réussi : pose le nouveau hash du corps publié, synced_at = maintenant, efface last_error.",
        inputSchema: { publication_id: z.string().uuid(), body_hash: z.string().min(1) },
      },
      async ({ publication_id, body_hash }, extra) =>
        json((await markSynced(wsOf(extra), publication_id, body_hash)) ?? { error: "publication introuvable dans ce workspace" })
    );
```

- [ ] **Step 3: Tests + commit**

```bash
npx vitest run tests/mcp-publications.test.ts tests/mcp-jobs.test.ts
npx tsc --noEmit -p tsconfig.json
git add "src/app/api/[transport]/route.ts" tests/mcp-publications.test.ts
git commit -m "feat(mcp): list_publications / link_publication / mark_synced"
```

---

### Task 9: Carte « Publication » (page contenu) + route de lecture + Re-synchroniser

**Files:**
- Create: `src/app/api/contents/[id]/publications/route.ts`, `src/components/cockpit/publication-card.tsx`
- Modify: `src/app/(app)/contents/[id]/page.tsx`
- Test: `tests/publications.test.ts` (ajout route)

**Interfaces:**
- Produces: `GET /api/contents/:id/publications` → `Array<Publication & { stale: boolean }>` (`stale` = `publishedBodyHash !== bodyHash(content.body)`) ; composant `<PublicationCard contentId body />`.

- [ ] **Step 1: Test de la route**

Ajouter à `tests/publications.test.ts` :

```ts
import { GET as pubsRoute } from "@/app/api/contents/[id]/publications/route";
import { authedReq, req } from "./helpers";
// …
it("GET /api/contents/:id/publications : 401 sans session, stale calculé, 404 hors workspace", async () => {
  const ws = await signUpTestUser();
  const contentId = await contentIn(ws, "# T\n\nv1");
  await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", url: "https://c.test/1", bodyHash: bodyHash("# T\n\nv1") });
  const p = { params: Promise.resolve({ id: contentId }) };
  expect((await pubsRoute(req(`/api/contents/${contentId}/publications`), p)).status).toBe(401);
  const ok = await pubsRoute(await authedReq(ws, `/api/contents/${contentId}/publications`), p);
  expect(ok.status).toBe(200);
  const rows = await ok.json();
  expect(rows[0].stale).toBe(false);
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv2", authorType: "user" });
  const again = await (await pubsRoute(await authedReq(ws, `/api/contents/${contentId}/publications`), p)).json();
  expect(again[0].stale).toBe(true);
  const b = await signUpTestUser();
  expect((await pubsRoute(await authedReq(b, `/api/contents/${contentId}/publications`), p)).status).toBe(404);
});
```

Run → FAIL.

- [ ] **Step 2: Route**

`src/app/api/contents/[id]/publications/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getContent } from "@/lib/contents";
import { listPublications, bodyHash } from "@/lib/publications";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const content = await getContent(workspaceId, id);
    if (!content) return NextResponse.json({ error: "not found" }, { status: 404 });
    const hash = bodyHash(content.body);
    const pubs = await listPublications(workspaceId, { contentId: id });
    return NextResponse.json(pubs.map((p) => ({ ...p, stale: p.publishedBodyHash !== hash })));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
```

- [ ] **Step 3: Composant**

`src/components/cockpit/publication-card.tsx` :

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { SectionCard } from "@/components/cockpit/section-card";
import { JobStatus } from "@/components/cockpit/job-status";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/hooks/use-jobs";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type Pub = {
  id: string; target: string; externalId: string; url: string; syncedAt: string | null;
  publishedAt: string | null; lastError: string | null; stale: boolean;
};

function ago(iso: string | null): string {
  if (!iso) return "jamais";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`;
}

/** Absente tant qu'aucune publication n'existe (le parent ne la monte qu'alors). */
export function PublicationCard({ contentId, bodyKey }: { contentId: string; bodyKey: string }) {
  const [pubs, setPubs] = useState<Pub[]>([]);
  const jobs = useJobs("content", contentId);
  const syncJob = jobs.latest("sync");
  const load = useCallback(async () => {
    const r = await fetch(`/api/contents/${contentId}/publications`);
    if (r.ok) setPubs(await r.json());
  }, [contentId]);
  useEffect(() => { load(); }, [load, bodyKey]);
  useWorkspaceEvents((e) => {
    if ((e.type === "job.updated" || e.type === "content.updated") && "contentId" in e ? e.contentId === contentId : (e as { targetId?: string }).targetId === contentId) load();
  });
  if (pubs.length === 0) return null;
  return (
    <SectionCard title="Publication">
      <ul className="space-y-3">
        {pubs.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{p.target}</span>
            {p.url && <a className="underline" href={p.url} target="_blank" rel="noreferrer">voir</a>}
            {p.lastError ? (
              <span className="text-danger">échec : {p.lastError}</span>
            ) : p.stale ? (
              <span className="text-warning">modifications en attente de sync</span>
            ) : (
              <span className="text-muted">synchronisé {ago(p.syncedAt)}</span>
            )}
            {(p.stale || p.lastError) && !(syncJob && (syncJob.status === "queued" || syncJob.status === "running")) && (
              <Button variant="outline" onClick={() => jobs.create("sync", { publication_id: p.id, target: p.target })}>
                Re-synchroniser
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3"><JobStatus job={syncJob} onRetry={jobs.retry} onCancel={jobs.cancel} renderDone={() => "Synchronisé"} /></div>
      {jobs.error && <p className="mt-2 text-sm text-danger">{jobs.error}</p>}
    </SectionCard>
  );
}
```

Le bouton Re-synchroniser passe par `POST /api/jobs` avec `kind: "sync"` ; la route de la Task 4 accepte tout kind, et `coalesce` n'est pas nécessaire ici (le bouton est masqué tant qu'un sync est actif).

- [ ] **Step 4: Monter la carte dans la page contenu**

Dans `src/app/(app)/contents/[id]/page.tsx`, après `<RevisionsPanel … />` :

```tsx
      <PublicationCard contentId={id} bodyKey={content.currentRevisionId ?? ""} />
```

- [ ] **Step 5: Vérifier + commit**

```bash
npx vitest run tests/publications.test.ts
npx tsc --noEmit -p tsconfig.json
git add "src/app/api/contents/[id]/publications/route.ts" src/components/cockpit/publication-card.tsx "src/app/(app)/contents/[id]/page.tsx" tests/publications.test.ts
git commit -m "feat(publications): carte Publication (synchronisé / en attente / échec + Re-synchroniser) et route de lecture"
```

---

# Partie 3 — Relecture & dictée

### Task 10: Tables `content_comments` + `comment_audio` + migration

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `drizzle/0006_*.sql`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: Test**

```ts
it("les tables content_comments et comment_audio existent (Task 10)", async () => {
  const names = await tableNames();
  expect(names).toContain("content_comments");
  expect(names).toContain("comment_audio");
});
```
→ FAIL.

- [ ] **Step 2: Schéma** (après `publications`) :

```ts
// ---- relecture : commentaires ancrés + dictée ---------------------------
// Ancrage = schéma VDL éprouvé : quote (texte surligné) + prefix/suffix (40
// caractères de contexte), robuste aux petites modifications du corps.
export const contentComments = pgTable("content_comments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  contentId: uuid("content_id").notNull()
    .references(() => contents.id, { onDelete: "cascade" }),
  quote: text("quote").notNull().default(""),
  prefix: text("prefix").notNull().default(""),
  suffix: text("suffix").notNull().default(""),
  section: text("section").notNull().default(""),
  body: text("body").notNull().default(""),
  kind: text("kind", { enum: ["text", "voice"] }).notNull().default("text"),
  status: text("status", { enum: ["open", "applied", "resolved"] }).notNull().default("open"),
  transcription: text("transcription", { enum: ["none", "pending", "done", "failed"] }).notNull().default("none"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("content_comments_content").on(t.contentId), index("content_comments_ws").on(t.workspaceId)]);

// Audio d'une note vocale, en base (≤ 16 Mo), purgé dès que la transcription
// aboutit. Pas de workspace_id : cloisonné par le commentaire parent — toute
// lecture passe par content_comments.workspace_id d'abord.
export const commentAudio = pgTable("comment_audio", {
  commentId: uuid("comment_id").primaryKey()
    .references(() => contentComments.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  bytes: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return "bytea"; } })("bytes").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

Ajouter `customType` à l'import de `drizzle-orm/pg-core` en tête de fichier.

- [ ] **Step 3: Migration + test + commit**

```bash
DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npx drizzle-kit generate
npx vitest run tests/schema.test.ts
git add src/lib/db/schema.ts drizzle/ tests/schema.test.ts
git commit -m "feat(relecture): tables content_comments (ancrage VDL) + comment_audio (bytea, purgé après transcription)"
```

---

### Task 11: `anchoring.ts` — retrouver un passage (port de `trouverPassage`)

**Files:**
- Create: `src/lib/anchoring.ts`
- Test: `tests/anchoring.test.ts`

**Interfaces:**
- Produces: `findPassage(full, quote, prefix, suffix) → { start: number; end: number; level: 1|2|3 } | null` ; `normalizeWs(s) → string`. Pur, sans DB — partagé serveur (MCP `list_comments`) et client (vue Relire).

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { findPassage } from "@/lib/anchoring";

const full = "Intro du post.\n\nOpenAI lance un modèle plus petit, moins cher, et plus rapide.\n\nConclusion.";

describe("findPassage", () => {
  it("niveau 1 : prefix+quote+suffix exacts", () => {
    const r = findPassage(full, "moins cher", "plus petit, ", ", et plus");
    expect(r).toEqual({ start: full.indexOf("moins cher"), end: full.indexOf("moins cher") + "moins cher".length, level: 1 });
  });
  it("niveau 2 : blancs modifiés dans le contexte", () => {
    const r = findPassage(full, "moins cher", "plus  petit,   ", ",\net plus");
    expect(r?.level).toBe(2);
    expect(full.slice(r!.start, r!.end)).toBe("moins cher");
  });
  it("niveau 3 : contexte disparu, quote seule (première occurrence)", () => {
    const r = findPassage(full, "Conclusion", "texte qui n'existe plus ", " idem");
    expect(r?.level).toBe(3);
    expect(full.slice(r!.start, r!.end)).toBe("Conclusion");
  });
  it("introuvable → null ; quote vide → null", () => {
    expect(findPassage(full, "phrase absente", "", "")).toBeNull();
    expect(findPassage(full, "", "Intro", " du")).toBeNull();
  });
  it("entités HTML et apostrophes typographiques normalisées au niveau 2", () => {
    const txt = "L’agent écrit « vite » &amp; bien.";
    const r = findPassage(txt, "vite", "L'agent écrit « ", " » & bien");
    expect(r).not.toBeNull();
    expect(txt.slice(r!.start, r!.end)).toBe("vite");
  });
});
```
→ FAIL.

- [ ] **Step 2: Implémentation**

`src/lib/anchoring.ts` :

```ts
/**
 * Ancrage d'un commentaire dans un texte (port de `trouverPassage`, outil de
 * relecture VDL). Trois niveaux, du plus strict au plus permissif ; null si
 * le passage a disparu (le commentaire reste listé, plus surligné).
 */
export function normalizeWs(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

export function findPassage(full: string, quote: string, prefix: string, suffix: string):
  { start: number; end: number; level: 1 | 2 | 3 } | null {
  if (!quote) return null;
  // 1 — exact, contexte compris
  const exact = full.indexOf((prefix || "") + quote + (suffix || ""));
  if (exact !== -1) {
    const start = exact + (prefix || "").length;
    return { start, end: start + quote.length, level: 1 };
  }
  // 2 — blancs/entités/apostrophes normalisés, en conservant une table des positions
  const map: number[] = [];
  let norm = "";
  for (let i = 0; i < full.length; i++) {
    const piece = normalizeWs(full[i]);
    // un caractère source peut produire 0..n caractères normalisés ; on garde
    // l'index source de chaque caractère produit, et on fusionne les blancs
    for (const ch of piece) {
      if (ch === " " && norm.endsWith(" ")) continue;
      norm += ch; map.push(i);
    }
  }
  const nq = normalizeWs(quote), np = normalizeWs(prefix || "").trimStart(), ns = normalizeWs(suffix || "").trimEnd();
  let idx = norm.indexOf(np + nq + ns);
  if (idx !== -1) {
    const s = idx + np.length;
    return { start: map[s], end: map[s + nq.length - 1] + 1, level: 2 };
  }
  // 3 — quote seule (première occurrence)
  const bare = full.indexOf(quote);
  if (bare !== -1) return { start: bare, end: bare + quote.length, level: 3 };
  idx = norm.indexOf(nq);
  if (idx !== -1) return { start: map[idx], end: map[idx + nq.length - 1] + 1, level: 3 };
  return null;
}
```

(Le test « entités » : `&amp;` dans `full` est 5 caractères source → 1 caractère normalisé ; `map` pointe sur le `&` ; comme la quote « vite » ne chevauche pas l'entité, les bornes restent exactes. Le niveau 2 est tolérant sur le contexte, pas sur l'intérieur de la quote : une quote contenant elle-même une entité se résout au niveau 3.)

- [ ] **Step 3: Tests + commit**

```bash
npx vitest run tests/anchoring.test.ts
git add src/lib/anchoring.ts tests/anchoring.test.ts
git commit -m "feat(relecture): findPassage — ancrage quote+prefix/suffix en trois niveaux"
```

---

### Task 12: Lib `comments.ts` + effets `transcribe` dans `jobs.ts` + cible `comment`

**Files:**
- Create: `src/lib/comments.ts`
- Modify: `src/lib/jobs.ts` (`assertTarget` comment ; `completeJob`/`failJob` effets transcribe), `src/lib/events.ts` (+ `comment.updated`)
- Test: `tests/comments.test.ts`

**Interfaces:**
- Produces :
  - `listComments(workspaceId, contentId, { status? }) → Comment[]` ; `getComment(workspaceId, id) → Comment | null`
  - `createComment(workspaceId, { contentId, body, quote?, prefix?, suffix?, section?, createdBy? }) → Comment` (kind `text`, transcription `none`)
  - `createVoiceComment(workspaceId, { contentId, audio: Buffer, mime, quote?, prefix?, suffix?, section?, createdBy? }) → { comment, job }` (kind `voice`, transcription `pending`, audio stocké, job `transcribe` cible `comment`)
  - `updateComment(workspaceId, id, { body?, status? }) → Comment | null` ; `deleteComment(workspaceId, id) → boolean`
  - `getCommentAudio(workspaceId, commentId) → { mime, bytes: Buffer } | null` ; `purgeCommentAudio(commentId)`
  - `applyTranscription(workspaceId, commentId, text)` / `failTranscription(workspaceId, commentId)` (appelés par `jobs.ts`)
  - constantes `MAX_COMMENT_BODY_LENGTH = 10000`, `MAX_QUOTE_LENGTH = 2000`, `MAX_CONTEXT_LENGTH = 200`, `MAX_AUDIO_BYTES = 16 * 1024 * 1024`, `AUDIO_MIMES = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"]`
- Événement : `{ type: "comment.updated"; contentId; commentId; status; transcription }`.

- [ ] **Step 1: Tests**

`tests/comments.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";
import { claimJob, completeJob, failJob, getJob, retryJob } from "@/lib/jobs";
import {
  listComments, createComment, createVoiceComment, updateComment, deleteComment,
  getCommentAudio, MAX_AUDIO_BYTES, MAX_COMMENT_BODY_LENGTH,
} from "@/lib/comments";

async function contentIn(ws: { workspaceId: string }) {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage à commenter.", authorType: "user" });
  return contentId;
}

describe("commentaires — texte", () => {
  it("crée, liste (plus anciens d'abord), met à jour, supprime ; cloisonné", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const c1 = await createComment(ws.workspaceId, { contentId, body: "trop long", quote: "passage", prefix: "Un ", suffix: " à commenter", createdBy: "u1" });
    expect(c1.kind).toBe("text");
    expect(c1.status).toBe("open");
    const c2 = await createComment(ws.workspaceId, { contentId, body: "remarque générale" });
    expect(c2.quote).toBe("");
    expect((await listComments(ws.workspaceId, contentId, {})).map((c) => c.id)).toEqual([c1.id, c2.id]);
    const up = await updateComment(ws.workspaceId, c1.id, { status: "resolved", body: "finalement ok" });
    expect(up!.status).toBe("resolved");
    expect((await listComments(ws.workspaceId, contentId, { status: "open" })).map((c) => c.id)).toEqual([c2.id]);
    expect(await deleteComment(ws.workspaceId, c2.id)).toBe(true);
    const b = await signUpTestUser();
    expect(await listComments(b.workspaceId, contentId, {})).toHaveLength(0);
    expect(await updateComment(b.workspaceId, c1.id, { status: "open" })).toBeNull();
    expect(await deleteComment(b.workspaceId, c1.id)).toBe(false);
    await expect(createComment(b.workspaceId, { contentId, body: "intrus" })).rejects.toThrow(/introuvable/);
  });

  it("bornes : body vide ou > 10 000, quote > 2 000 → erreur", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    await expect(createComment(ws.workspaceId, { contentId, body: "  " })).rejects.toThrow(/body requis/);
    await expect(createComment(ws.workspaceId, { contentId, body: "x".repeat(MAX_COMMENT_BODY_LENGTH + 1) })).rejects.toThrow(/trop long/);
    await expect(createComment(ws.workspaceId, { contentId, body: "ok", quote: "q".repeat(2001) })).rejects.toThrow(/quote trop long/);
  });

  it("émet comment.updated à la création et à la mise à jour", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const seen: WorkspaceEvent[] = [];
    const un = bus.subscribe(ws.workspaceId, (e) => { if (e.type === "comment.updated") seen.push(e); });
    const c = await createComment(ws.workspaceId, { contentId, body: "x" });
    await updateComment(ws.workspaceId, c.id, { status: "applied" });
    un();
    expect(seen).toHaveLength(2);
    expect((seen[1] as { status: string }).status).toBe("applied");
  });
});

describe("commentaires — dictée", () => {
  it("createVoiceComment : commentaire voice pending + audio stocké + job transcribe queued", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, {
      contentId, audio: Buffer.from("fake-webm"), mime: "audio/webm", quote: "passage", prefix: "Un ", suffix: " à",
    });
    expect(comment.kind).toBe("voice");
    expect(comment.transcription).toBe("pending");
    expect(comment.body).toBe("");
    expect(job.kind).toBe("transcribe");
    expect(job.targetType).toBe("comment");
    expect(job.targetId).toBe(comment.id);
    const audio = await getCommentAudio(ws.workspaceId, comment.id);
    expect(audio!.mime).toBe("audio/webm");
    expect(audio!.bytes.toString()).toBe("fake-webm");
    const b = await signUpTestUser();
    expect(await getCommentAudio(b.workspaceId, comment.id)).toBeNull();
  });

  it("refuse un audio vide, > 16 Mo, ou d'un mime inconnu", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.alloc(0), mime: "audio/webm" })).rejects.toThrow(/audio vide/);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mime: "audio/webm" })).rejects.toThrow(/trop gros/);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("x"), mime: "video/mp4" })).rejects.toThrow(/mime/);
  });

  it("complete_job({text}) remplit le commentaire, passe done, purge l'audio ; fail_job → failed, audio conservé ; retry repart", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "whisper indisponible");
    let c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("failed");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).not.toBeNull();
    await retryJob(ws.workspaceId, job.id);
    await claimJob(ws.workspaceId, job.id, "w");
    await completeJob(ws.workspaceId, job.id, { text: "Raccourcis ce paragraphe." });
    c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("done");
    expect(c.body).toBe("Raccourcis ce paragraphe.");
    expect(c.status).toBe("open");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).toBeNull();
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("done");
  });

  it("complete_job sans text sur un transcribe → le job échoue proprement (failed) au lieu de laisser le commentaire pending", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await claimJob(ws.workspaceId, job.id, "w");
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/text requis/);
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("running");
  });
});
```

- [ ] **Step 2: Lancer → FAIL.**

- [ ] **Step 3: Événement**

`src/lib/events.ts`, ajouter au type :

```ts
  | { type: "comment.updated"; contentId: string; commentId: string; status: string; transcription: string };
```

- [ ] **Step 4: Lib `comments.ts`**

```ts
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { commentAudio, contentComments, contents } from "@/lib/db/schema";
import { bus } from "@/lib/events";
import { createJob, type Job } from "@/lib/jobs";

export type Comment = typeof contentComments.$inferSelect;
export const MAX_COMMENT_BODY_LENGTH = 10000;
export const MAX_QUOTE_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 200;
export const MAX_SECTION_LENGTH = 300;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const AUDIO_MIMES = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"];

type Anchor = { quote?: string; prefix?: string; suffix?: string; section?: string };

function publish(c: Comment) {
  bus.publish(c.workspaceId, {
    type: "comment.updated", contentId: c.contentId, commentId: c.id,
    status: c.status, transcription: c.transcription,
  });
}

async function assertContent(workspaceId: string, contentId: string) {
  const [row] = await db.select({ id: contents.id }).from(contents)
    .where(and(eq(contents.id, contentId), eq(contents.workspaceId, workspaceId)));
  if (!row) throw new Error("content introuvable dans ce workspace");
}

function checkAnchor(a: Anchor) {
  if (a.quote !== undefined && a.quote.length > MAX_QUOTE_LENGTH) throw new Error(`quote trop long (max ${MAX_QUOTE_LENGTH} caractères)`);
  for (const k of ["prefix", "suffix"] as const)
    if (a[k] !== undefined && a[k]!.length > MAX_CONTEXT_LENGTH) throw new Error(`${k} trop long (max ${MAX_CONTEXT_LENGTH} caractères)`);
  if (a.section !== undefined && a.section.length > MAX_SECTION_LENGTH) throw new Error(`section trop long (max ${MAX_SECTION_LENGTH} caractères)`);
}

function anchorValues(a: Anchor): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (a.quote !== undefined) v.quote = a.quote;
  if (a.prefix !== undefined) v.prefix = a.prefix;
  if (a.suffix !== undefined) v.suffix = a.suffix;
  if (a.section !== undefined) v.section = a.section;
  return v;
}

export async function listComments(workspaceId: string, contentId: string, filter: { status?: "open" | "applied" | "resolved" }) {
  const conds = [eq(contentComments.workspaceId, workspaceId), eq(contentComments.contentId, contentId)];
  if (filter.status) conds.push(eq(contentComments.status, filter.status));
  return db.select().from(contentComments).where(and(...conds)).orderBy(asc(contentComments.createdAt));
}

export async function getComment(workspaceId: string, id: string) {
  const [row] = await db.select().from(contentComments)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId)));
  return row ?? null;
}

export async function createComment(workspaceId: string, input: Anchor & { contentId: string; body: string; createdBy?: string }) {
  const body = input.body.trim();
  if (!body) throw new Error("body requis");
  if (body.length > MAX_COMMENT_BODY_LENGTH) throw new Error(`body trop long (max ${MAX_COMMENT_BODY_LENGTH} caractères)`);
  checkAnchor(input);
  await assertContent(workspaceId, input.contentId);
  const values: Record<string, unknown> = { workspaceId, contentId: input.contentId, body, kind: "text", ...anchorValues(input) };
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;
  const [row] = await db.insert(contentComments).values(values as never).returning();
  publish(row);
  return row;
}

export async function createVoiceComment(workspaceId: string, input: Anchor & {
  contentId: string; audio: Buffer; mime: string; createdBy?: string;
}): Promise<{ comment: Comment; job: Job }> {
  if (!input.audio.length) throw new Error("audio vide");
  if (input.audio.length > MAX_AUDIO_BYTES) throw new Error(`audio trop gros (max ${MAX_AUDIO_BYTES} octets)`);
  const mime = input.mime.split(";")[0].trim();
  if (!AUDIO_MIMES.some((m) => m.split(";")[0] === mime)) throw new Error(`mime audio non supporté : ${input.mime}`);
  checkAnchor(input);
  await assertContent(workspaceId, input.contentId);
  const comment = await db.transaction(async (tx) => {
    const values: Record<string, unknown> = {
      workspaceId, contentId: input.contentId, body: "", kind: "voice", transcription: "pending", ...anchorValues(input),
    };
    if (input.createdBy !== undefined) values.createdBy = input.createdBy;
    const [row] = await tx.insert(contentComments).values(values as never).returning();
    await tx.insert(commentAudio).values({ commentId: row.id, mime: input.mime, bytes: input.audio, size: input.audio.length });
    return row;
  });
  publish(comment);
  const { job } = await createJob(workspaceId, {
    kind: "transcribe", targetType: "comment", targetId: comment.id,
    payload: { content_id: input.contentId, mime: input.mime, size: input.audio.length },
    requestedBy: input.createdBy ? `user:${input.createdBy}` : "system:voice-comment",
  });
  return { comment, job };
}

export async function updateComment(workspaceId: string, id: string, patch: { body?: string; status?: "open" | "applied" | "resolved" }) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.body !== undefined) {
    if (patch.body.length > MAX_COMMENT_BODY_LENGTH) throw new Error(`body trop long (max ${MAX_COMMENT_BODY_LENGTH} caractères)`);
    set.body = patch.body;
  }
  if (patch.status !== undefined) set.status = patch.status;
  const [row] = await db.update(contentComments).set(set as never)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId))).returning();
  if (row) publish(row);
  return row ?? null;
}

export async function deleteComment(workspaceId: string, id: string): Promise<boolean> {
  const rows = await db.delete(contentComments)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId))).returning({ id: contentComments.id });
  return rows.length > 0;
}

/** Cloisonné par le commentaire parent (comment_audio n'a pas de workspace_id). */
export async function getCommentAudio(workspaceId: string, commentId: string) {
  const c = await getComment(workspaceId, commentId);
  if (!c) return null;
  const [row] = await db.select().from(commentAudio).where(eq(commentAudio.commentId, commentId));
  return row ? { mime: row.mime, bytes: Buffer.from(row.bytes) } : null;
}

export async function purgeCommentAudio(commentId: string) {
  await db.delete(commentAudio).where(eq(commentAudio.commentId, commentId));
}

/** Effets de complétion/échec d'un job transcribe — appelés par jobs.ts. */
export async function applyTranscription(workspaceId: string, commentId: string, text: string) {
  const [row] = await db.update(contentComments)
    .set({ body: text.slice(0, MAX_COMMENT_BODY_LENGTH), transcription: "done", updatedAt: new Date() })
    .where(and(eq(contentComments.id, commentId), eq(contentComments.workspaceId, workspaceId))).returning();
  if (!row) return null;
  await purgeCommentAudio(commentId);
  publish(row);
  return row;
}

export async function failTranscription(workspaceId: string, commentId: string) {
  const [row] = await db.update(contentComments)
    .set({ transcription: "failed", updatedAt: new Date() })
    .where(and(eq(contentComments.id, commentId), eq(contentComments.workspaceId, workspaceId))).returning();
  if (row) publish(row);
  return row ?? null;
}
```

- [ ] **Step 5: `jobs.ts` — cible `comment` + effets transcribe**

Dans `assertTarget`, ajouter la branche (importer `contentComments` du schéma) :

```ts
  } else if (targetType === "comment") {
    const [row] = await db.select({ id: contentComments.id }).from(contentComments)
      .where(and(eq(contentComments.id, targetId), eq(contentComments.workspaceId, workspaceId)));
    if (row) return;
  }
```

`completeJob` devient :

```ts
export async function completeJob(workspaceId: string, id: string, result: Record<string, unknown> = {}): Promise<Job | null> {
  if (jsonBytes(result) > MAX_JOB_JSON_BYTES) throw new Error(`result trop gros (max ${MAX_JOB_JSON_BYTES} octets)`);
  const current = await getJob(workspaceId, id);
  if (current?.kind === "transcribe" && current.targetType === "comment" && typeof result.text !== "string")
    throw new Error("result.text requis pour un job transcribe");
  const row = await finish(workspaceId, id, { status: "done", result });
  if (row && row.kind === "transcribe" && row.targetType === "comment") {
    const { applyTranscription } = await import("@/lib/comments");
    await applyTranscription(workspaceId, row.targetId, result.text as string);
  }
  return row;
}
```

et dans `applyFailureEffects` :

```ts
  if (job.kind === "transcribe" && job.targetType === "comment") {
    const { failTranscription } = await import("@/lib/comments");
    await failTranscription(job.workspaceId, job.targetId);
  }
```

(imports dynamiques : `comments.ts` importe `createJob` de `jobs.ts`.)

- [ ] **Step 6: Tests + commit**

```bash
npx vitest run tests/comments.test.ts tests/jobs.test.ts
npx tsc --noEmit -p tsconfig.json
git add src/lib/comments.ts src/lib/jobs.ts src/lib/events.ts tests/comments.test.ts
git commit -m "feat(relecture): lib commentaires (texte + dictée avec audio et job transcribe), effets de complétion/échec"
```

---

### Task 13: Routes commentaires (session) + upload audio + route token `GET /api/jobs/:id/audio`

**Files:**
- Create: `src/app/api/contents/[id]/comments/route.ts`, `src/app/api/contents/[id]/comments/[cid]/route.ts`, `src/app/api/contents/[id]/comments/audio/route.ts`, `src/app/api/jobs/[id]/audio/route.ts`
- Test: `tests/comments-routes.test.ts`

**Interfaces:**
- `GET /api/contents/:id/comments?status=` → `Comment[]` ; `POST` `{body, quote?, prefix?, suffix?, section?}` → 201 Comment
- `PATCH /api/contents/:id/comments/:cid` `{body?, status?}` → Comment ; `DELETE` → `{ok:true}`
- `POST /api/contents/:id/comments/audio?quote=&prefix=&suffix=&section=` (corps binaire, `content-type` = mime) → 201 `{comment, job}` ; 413 si > 16 Mo ; 415 si mime inconnu
- `GET /api/jobs/:id/audio` (Bearer `cs_…`) → corps binaire `content-type: <mime>` ; 401 sans/mauvais token ; 404 si le job n'est pas un `transcribe` du workspace du token, ou audio déjà purgé

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { GET as listRoute, POST as createRoute } from "@/app/api/contents/[id]/comments/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/contents/[id]/comments/[cid]/route";
import { POST as audioRoute } from "@/app/api/contents/[id]/comments/audio/route";
import { GET as jobAudioRoute } from "@/app/api/jobs/[id]/audio/route";
import { completeJob, claimJob } from "@/lib/jobs";

const P = (id: string, cid?: string) => ({ params: Promise.resolve(cid ? { id, cid } : { id }) }) as never;
const jsonInit = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function contentIn(ws: { workspaceId: string }) {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage.", authorType: "user" });
  return contentId;
}

describe("routes commentaires", () => {
  it("401 sans session sur GET/POST/PATCH/DELETE/audio", async () => {
    const id = crypto.randomUUID();
    expect((await listRoute(req(`/api/contents/${id}/comments`), P(id))).status).toBe(401);
    expect((await createRoute(req(`/api/contents/${id}/comments`, jsonInit({ body: "x" })), P(id))).status).toBe(401);
    expect((await patchRoute(req(`/api/contents/${id}/comments/${id}`, jsonInit({ body: "x" }, "PATCH")), P(id, id))).status).toBe(401);
    expect((await deleteRoute(req(`/api/contents/${id}/comments/${id}`, { method: "DELETE" }), P(id, id))).status).toBe(401);
    expect((await audioRoute(req(`/api/contents/${id}/comments/audio`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "x" }), P(id))).status).toBe(401);
  });

  it("POST crée (201) avec ancrage ; GET liste ; PATCH statut ; DELETE ; 404 hors workspace", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const c = await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: "à revoir", quote: "passage", prefix: "Un ", suffix: "." })), P(contentId));
    expect(c.status).toBe(201);
    const created = await c.json();
    expect(created.quote).toBe("passage");
    const l = await (await listRoute(await authedReq(ws, `/api/contents/${contentId}/comments`), P(contentId))).json();
    expect(l).toHaveLength(1);
    const up = await patchRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${created.id}`, jsonInit({ status: "resolved" }, "PATCH")), P(contentId, created.id));
    expect((await up.json()).status).toBe("resolved");
    const b = await signUpTestUser();
    expect((await listRoute(await authedReq(b, `/api/contents/${contentId}/comments`), P(contentId))).status).toBe(404);
    expect((await patchRoute(await authedReq(b, `/api/contents/${contentId}/comments/${created.id}`, jsonInit({ status: "open" }, "PATCH")), P(contentId, created.id))).status).toBe(404);
    expect((await deleteRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${created.id}`, { method: "DELETE" }), P(contentId, created.id))).status).toBe(200);
  });

  it("POST body vide → 400 ; statut inconnu en PATCH → 400", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    expect((await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: " " })), P(contentId))).status).toBe(400);
    const c = await (await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: "ok" })), P(contentId))).json();
    expect((await patchRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${c.id}`, jsonInit({ status: "bizarre" }, "PATCH")), P(contentId, c.id))).status).toBe(400);
  });

  it("audio : 201 {comment, job} ; 415 mime inconnu ; 413 trop gros", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const ok = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio?quote=passage&prefix=Un%20&suffix=.`, {
      method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: new Uint8Array([1, 2, 3]),
    }), P(contentId));
    expect(ok.status).toBe(201);
    const { comment, job } = await ok.json();
    expect(comment.kind).toBe("voice");
    expect(comment.quote).toBe("passage");
    expect(job.kind).toBe("transcribe");
    const bad = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), P(contentId));
    expect(bad.status).toBe(415);
    const big = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(16 * 1024 * 1024 + 1) }), P(contentId));
    expect(big.status).toBe(413);
  });

  it("GET /api/jobs/:id/audio : 401 sans token ; 200 binaire avec le bon token ; 404 autre workspace ; 404 après transcription (audio purgé)", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { job } = await (await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, {
      method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([9, 8, 7]),
    }), P(contentId))).json();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`), P(job.id))).status).toBe(401);
    const r = await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), P(job.id));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/webm");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${tb}` } }), P(job.id))).status).toBe(404);
    await claimJob(ws.workspaceId, job.id, "w");
    await completeJob(ws.workspaceId, job.id, { text: "ok" });
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), P(job.id))).status).toBe(404);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Routes**

`src/app/api/contents/[id]/comments/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getContent } from "@/lib/contents";
import { listComments, createComment } from "@/lib/comments";

const STATUSES = ["open", "applied", "resolved"] as const;
type P = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    if (!(await getContent(workspaceId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    if (status && !STATUSES.includes(status as never)) return NextResponse.json({ error: "status invalide" }, { status: 400 });
    return NextResponse.json(await listComments(workspaceId, id, { status: status as never }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest, { params }: P) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const { id } = await params;
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "corps invalide" }, { status: 400 }); }
    if (typeof body?.body !== "string") return NextResponse.json({ error: "body requis" }, { status: 400 });
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const c = await createComment(workspaceId, {
      contentId: id, body: body.body, quote: str("quote"), prefix: str("prefix"), suffix: str("suffix"), section: str("section"), createdBy: userId,
    });
    return NextResponse.json(c, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable")) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && (e.message.includes("requis") || e.message.includes("trop long"))) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

`src/app/api/contents/[id]/comments/[cid]/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getComment, updateComment, deleteComment } from "@/lib/comments";

const STATUSES = ["open", "applied", "resolved"] as const;
type P = { params: Promise<{ id: string; cid: string }> };

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id, cid } = await params;
    const existing = await getComment(workspaceId, cid);
    if (!existing || existing.contentId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const patch: { body?: string; status?: (typeof STATUSES)[number] } = {};
    if (body.body !== undefined) {
      if (typeof body.body !== "string") return NextResponse.json({ error: "body doit être une chaîne" }, { status: 400 });
      patch.body = body.body;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "status invalide" }, { status: 400 });
      patch.status = body.status;
    }
    const row = await updateComment(workspaceId, cid, patch);
    return NextResponse.json(row);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id, cid } = await params;
    const existing = await getComment(workspaceId, cid);
    if (!existing || existing.contentId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
    await deleteComment(workspaceId, cid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
```

`src/app/api/contents/[id]/comments/audio/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createVoiceComment, MAX_AUDIO_BYTES, AUDIO_MIMES } from "@/lib/comments";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const mime = (req.headers.get("content-type") ?? "").trim();
    if (!AUDIO_MIMES.some((m) => m.split(";")[0] === mime.split(";")[0]))
      return NextResponse.json({ error: "type audio non supporté" }, { status: 415 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const sp = req.nextUrl.searchParams;
    const r = await createVoiceComment(workspaceId, {
      contentId: id, audio: buf, mime, createdBy: userId,
      quote: sp.get("quote") ?? undefined, prefix: sp.get("prefix") ?? undefined,
      suffix: sp.get("suffix") ?? undefined, section: sp.get("section") ?? undefined,
    });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable")) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && e.message.includes("audio vide")) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("trop gros")) return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof Error && e.message.includes("mime")) return NextResponse.json({ error: e.message }, { status: 415 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
```

`src/app/api/jobs/[id]/audio/route.ts` (token, lecture seule) :

```ts
import { NextRequest, NextResponse } from "next/server";
import { resolveMcpToken } from "@/lib/tenant";
import { getJob } from "@/lib/jobs";
import { getCommentAudio } from "@/lib/comments";

/**
 * La seule route REST binaire ouverte au token MCP : l'audio du commentaire
 * visé par un job transcribe du workspace du token. 404 pour tout le reste
 * (job d'un autre workspace, pas un transcribe, audio déjà purgé).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveMcpToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const job = await getJob(auth.workspaceId, (await params).id);
  if (!job || job.kind !== "transcribe" || job.targetType !== "comment")
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const audio = await getCommentAudio(auth.workspaceId, job.targetId);
  if (!audio) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(audio.bytes), {
    status: 200,
    headers: { "content-type": audio.mime, "content-length": String(audio.bytes.length), "cache-control": "no-store" },
  });
}
```

- [ ] **Step 3: Tests + commit**

```bash
npx vitest run tests/comments-routes.test.ts tests/comments.test.ts
npx tsc --noEmit -p tsconfig.json
git add "src/app/api/contents/[id]/comments" "src/app/api/jobs/[id]/audio" tests/comments-routes.test.ts
git commit -m "feat(relecture): routes commentaires (CRUD, upload audio 16 Mo) + GET /api/jobs/:id/audio en Bearer token"
```

---

### Task 14: Outils MCP `list_comments` / `resolve_comment`

**Files:**
- Modify: `src/app/api/[transport]/route.ts`
- Test: `tests/mcp-comments.test.ts`

**Interfaces:**
- `list_comments(content_id, status?)` → commentaires + pour chacun `anchor_found: boolean`, `position: {start, end, level} | null` calculés sur le markdown courant via `findPassage` ; `resolve_comment(comment_id, status)` (`open`|`applied`|`resolved`).

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { createComment, getComment } from "@/lib/comments";

describe("MCP — commentaires", () => {
  it("list_comments rend les commentaires avec ancrage résolu ; resolve_comment change le statut ; cloisonnés", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const idea = await createIdea(ws.workspaceId, { title: "I" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage à raccourcir ici.", authorType: "user" });
    const c = await createComment(ws.workspaceId, { contentId, body: "raccourcis", quote: "passage à raccourcir", prefix: "Un ", suffix: " ici" });
    const orphan = await createComment(ws.workspaceId, { contentId, body: "général" });
    const r = JSON.parse((await callMcpTool(token, "list_comments", { content_id: contentId, status: "open" })).texte);
    expect(r).toHaveLength(2);
    const a = r.find((x: { id: string }) => x.id === c.id);
    expect(a.anchor_found).toBe(true);
    expect(a.position.level).toBe(1);
    expect(r.find((x: { id: string }) => x.id === orphan.id).anchor_found).toBe(false);
    const res = JSON.parse((await callMcpTool(token, "resolve_comment", { comment_id: c.id, status: "applied" })).texte);
    expect(res.status).toBe("applied");
    expect((await getComment(ws.workspaceId, c.id))!.status).toBe("applied");
    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect(JSON.parse((await callMcpTool(tb, "list_comments", { content_id: contentId })).texte).error).toMatch(/introuvable/);
    expect(JSON.parse((await callMcpTool(tb, "resolve_comment", { comment_id: c.id, status: "open" })).texte).error).toMatch(/introuvable/);
  });
});
```
→ FAIL.

- [ ] **Step 2: Outils**

Importer `{ listComments, updateComment }` de `@/lib/comments`, `{ findPassage }` de `@/lib/anchoring`, et enregistrer :

```ts
    // ---- relecture : les remarques de l'humain, à appliquer par l'agent -------
    server.registerTool(
      "list_comments",
      {
        description: "Les commentaires de relecture d'un contenu (surlignage + remarque, écrite ou dictée). Chaque entrée porte quote/prefix/suffix (ancrage), body (la remarque), status (open = à traiter), et anchor_found/position calculés sur le markdown courant (start/end = offsets dans le corps ; null si le passage a disparu). Appliquer = réécrire uniquement les passages visés, puis resolve_comment(status: applied).",
        inputSchema: { content_id: z.string().uuid(), status: z.enum(["open", "applied", "resolved"]).optional() },
      },
      async ({ content_id, status }, extra) => {
        const workspaceId = wsOf(extra);
        const content = await getContent(workspaceId, content_id);
        if (!content) return json({ error: "contenu introuvable dans ce workspace" });
        const rows = await listComments(workspaceId, content_id, { status });
        return json(rows.map((c) => {
          const position = c.quote ? findPassage(content.body, c.quote, c.prefix, c.suffix) : null;
          return { ...c, anchor_found: position !== null, position };
        }));
      }
    );
    server.registerTool(
      "resolve_comment",
      {
        description: "Change le statut d'un commentaire : applied (l'agent a appliqué la remarque), resolved (clos sans changement), open (rouvert).",
        inputSchema: { comment_id: z.string().uuid(), status: z.enum(["open", "applied", "resolved"]) },
      },
      async ({ comment_id, status }, extra) =>
        json((await updateComment(wsOf(extra), comment_id, { status })) ?? { error: "commentaire introuvable dans ce workspace" })
    );
```

- [ ] **Step 3: Tests + commit**

```bash
npx vitest run tests/mcp-comments.test.ts
npx tsc --noEmit -p tsconfig.json
git add "src/app/api/[transport]/route.ts" tests/mcp-comments.test.ts
git commit -m "feat(mcp): list_comments (ancrage résolu sur le markdown courant) + resolve_comment"
```

---

### Task 15: Onglet « Relire » — rendu lecture, surlignage, popover, dictée, liste, bouton « Appliquer les commentaires »

**Files:**
- Create: `src/components/review/review-pane.tsx`, `src/components/review/comment-popover.tsx`, `src/components/review/comment-list.tsx`, `src/components/review/use-recorder.ts`, `src/components/review/use-comments.ts`
- Modify: `src/app/(app)/contents/[id]/page.tsx`
- Test: vérification manuelle (checklist ci-dessous) + typecheck. Les hooks/algos testables (ancrage) le sont déjà en Task 11.

**Interfaces:**
- Consumes: routes Task 13, `findPassage`/`normalizeWs` (Task 11), `useJobs` (Task 5), SSE `comment.updated`.
- Produces: `<ReviewPane contentId body />` ; hook `useComments(contentId)` ; hook `useRecorder()` → `{ supported, recording, start(), stop() → Promise<{ blob, mime }> }`.

**Choix techniques (pas de nouvelle dépendance)** :
- Rendu lecture = un `useEditor` tiptap `editable: false` avec `StarterKit + Markdown` (déjà utilisés par `editor.tsx`) — le DOM est stable et sélectionnable.
- Surlignage = **CSS Custom Highlight API** (`CSS.highlights`, Chrome ≥ 105 / Safari ≥ 17.2) : on enregistre des `Range` sous deux noms (`cs-pending` jaune, `cs-comment` vert) — aucune mutation du DOM rendu par tiptap, donc aucun conflit avec React. Si `CSS.highlights` est absent, la liste et les commentaires fonctionnent ; seul le surlignage manque (note discrète dans la colonne).
- Offsets = calculés sur `root.textContent` (le texte « plein ») ; passage `texte plein → Range DOM` via un `TreeWalker` sur les nœuds texte (cumul des longueurs).
- Ancrage à la création = `quote` = sélection, `prefix`/`suffix` = 40 caractères avant/après dans le texte plein, `section` = dernier titre (`h1-h3`) précédant la sélection.

- [ ] **Step 1: `use-recorder.ts`**

```ts
"use client";
import { useCallback, useRef, useState } from "react";

const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
export const MAX_RECORD_MS = 3 * 60_000;

export function useRecorder() {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recording, setRecording] = useState(false);
  const supported = typeof window !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

  const stop = useCallback((): Promise<{ blob: Blob; mime: string } | null> => new Promise((resolve) => {
    const r = rec.current;
    if (!r || r.state === "inactive") { resolve(null); return; }
    r.onstop = () => {
      const mime = r.mimeType || "audio/webm";
      resolve({ blob: new Blob(chunks.current, { type: mime }), mime });
      r.stream.getTracks().forEach((t) => t.stop());
      rec.current = null; chunks.current = [];
      setRecording(false);
    };
    r.stop();
    if (timer.current) clearTimeout(timer.current);
  }), []);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    rec.current = r;
    r.start(250);
    setRecording(true);
    timer.current = setTimeout(() => { stop(); }, MAX_RECORD_MS);
  }, [stop]);

  return { supported, recording, start, stop };
}
```

- [ ] **Step 2: `use-comments.ts`**

```ts
"use client";
import { useCallback, useEffect, useState } from "react";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export type CommentRow = {
  id: string; quote: string; prefix: string; suffix: string; section: string; body: string;
  kind: "text" | "voice"; status: "open" | "applied" | "resolved";
  transcription: "none" | "pending" | "done" | "failed"; createdAt: string;
};
export type Anchor = { quote: string; prefix: string; suffix: string; section: string };

export function useComments(contentId: string) {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const r = await fetch(`/api/contents/${contentId}/comments`);
    if (r.ok) setComments(await r.json());
  }, [contentId]);
  useEffect(() => { refresh(); }, [refresh]);
  useWorkspaceEvents((e) => { if (e.type === "comment.updated" && e.contentId === contentId) refresh(); });

  const fail = async (res: Response, fallback: string) => {
    const { error: m } = await res.json().catch(() => ({ error: null }));
    setError(m ?? fallback);
  };
  const createText = useCallback(async (body: string, anchor: Anchor | null) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, ...(anchor ?? {}) }),
    });
    if (!res.ok) { await fail(res, "Échec de l'enregistrement du commentaire."); return null; }
    await refresh();
    return (await res.json()) as CommentRow;
  }, [contentId, refresh]);
  const createVoice = useCallback(async (blob: Blob, mime: string, anchor: Anchor | null) => {
    setError(null);
    const q = new URLSearchParams();
    if (anchor) for (const [k, v] of Object.entries(anchor)) q.set(k, v);
    const res = await fetch(`/api/contents/${contentId}/comments/audio?${q}`, { method: "POST", headers: { "content-type": mime }, body: blob });
    if (!res.ok) { await fail(res, "Échec de l'envoi de la dictée."); return null; }
    await refresh();
    return (await res.json()).comment as CommentRow;
  }, [contentId, refresh]);
  const update = useCallback(async (id: string, patch: { body?: string; status?: CommentRow["status"] }) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (!res.ok) await fail(res, "Échec de la mise à jour.");
    await refresh();
  }, [contentId, refresh]);
  const remove = useCallback(async (id: string) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments/${id}`, { method: "DELETE" });
    if (!res.ok) await fail(res, "Échec de la suppression.");
    await refresh();
  }, [contentId, refresh]);
  return { comments, error, refresh, createText, createVoice, update, remove };
}
```

- [ ] **Step 3: `comment-popover.tsx`** (textarea + 🎙️ + Enregistrer/Annuler ; en mode édition : Résoudre / Supprimer)

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRecorder } from "@/components/review/use-recorder";
import type { CommentRow } from "@/components/review/use-comments";

export function CommentPopover({ existing, onSaveText, onSaveVoice, onResolve, onDelete, onClose, style }: {
  existing: CommentRow | null;
  onSaveText: (body: string) => Promise<void>;
  onSaveVoice: (blob: Blob, mime: string) => Promise<void>;
  onResolve?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
  style: React.CSSProperties;
}) {
  const [text, setText] = useState(existing?.body ?? "");
  const { supported, recording, start, stop } = useRecorder();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { setText(existing?.body ?? ""); }, [existing?.body]);

  async function dicter() {
    if (recording) {
      const r = await stop();
      if (r) await onSaveVoice(r.blob, r.mime);
    } else {
      try { await start(); } catch { /* micro refusé : rien à faire, le bouton reste */ }
    }
  }

  return (
    <div style={style} className="absolute z-20 w-80 rounded-xl border border-line bg-surface p-3 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) onSaveText(text.trim());
      }}>
      {existing?.transcription === "pending" && <p className="mb-2 text-xs text-muted animate-pulse">Transcription en cours…</p>}
      {existing?.transcription === "failed" && <p className="mb-2 text-xs text-danger">Transcription échouée — écris la remarque, ou réessaie depuis la liste.</p>}
      <Textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={existing ? "Modifier la remarque…" : "Ta remarque (Cmd+Entrée pour enregistrer)"} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button onClick={() => text.trim() && onSaveText(text.trim())} disabled={!text.trim()}>Enregistrer</Button>
        {supported && !existing && (
          <Button variant="outline" onClick={dicter}>{recording ? "■ Terminer la dictée" : "🎙️ Dicter"}</Button>
        )}
        {existing && onResolve && <Button variant="outline" onClick={onResolve}>Résoudre</Button>}
        {existing && onDelete && <Button variant="outline" onClick={onDelete}>Supprimer</Button>}
        <Button variant="outline" onClick={onClose}>Fermer</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: `comment-list.tsx`** (colonne latérale)

```tsx
"use client";
import { StatusBadge } from "@/components/cockpit/status-badge";
import type { CommentRow } from "@/components/review/use-comments";

export function CommentList({ comments, lost, onSelect, onGeneral, highlightsSupported }: {
  comments: CommentRow[]; lost: Set<string>;
  onSelect: (c: CommentRow) => void; onGeneral: () => void; highlightsSupported: boolean;
}) {
  const open = comments.filter((c) => c.status === "open");
  const closed = comments.filter((c) => c.status !== "open");
  const Card = ({ c }: { c: CommentRow }) => (
    <button type="button" onClick={() => onSelect(c)}
      className={`w-full rounded-lg border border-line bg-raised/40 p-2 text-left text-xs hover:border-line-strong ${c.status !== "open" ? "opacity-60" : ""}`}>
      {c.quote ? <span className="line-clamp-1 italic text-muted">« {c.quote} »</span> : <span className="text-muted">Commentaire général</span>}
      <span className="mt-1 block line-clamp-3">{c.transcription === "pending" ? "Transcription en cours…" : c.body || "—"}</span>
      <span className="mt-1 flex items-center gap-1">
        <StatusBadge kind="content" value={c.status === "open" ? "review" : c.status === "applied" ? "published" : "draft"} />
        {c.kind === "voice" && <span className="text-faint">🎙️</span>}
        {c.transcription === "failed" && <span className="text-danger">transcription échouée</span>}
        {c.quote && lost.has(c.id) && <span className="text-warning">⚠️ passage introuvable</span>}
      </span>
    </button>
  );
  return (
    <aside className="space-y-3">
      {!highlightsSupported && <p className="text-xs text-faint">Surlignage indisponible dans ce navigateur — la liste reste fonctionnelle.</p>}
      <button type="button" onClick={onGeneral} className="w-full rounded-lg border border-dashed border-line p-2 text-xs text-muted hover:border-line-strong">+ Commentaire général</button>
      {open.map((c) => <Card key={c.id} c={c} />)}
      {closed.length > 0 && (
        <details className="text-xs"><summary className="cursor-pointer text-faint">{closed.length} traité{closed.length > 1 ? "s" : ""}</summary>
          <div className="mt-2 space-y-2">{closed.map((c) => <Card key={c.id} c={c} />)}</div>
        </details>
      )}
    </aside>
  );
}
```

(Le badge réutilise `StatusBadge` avec des valeurs existantes pour ne pas ajouter de teintes : open→`review` (ambre), applied→`published` (vert), resolved→`draft` (gris). Si l'équipe préfère des libellés exacts, ajouter `open/applied/resolved` à `VALUE_TONE` — même teintes.)

- [ ] **Step 5: `review-pane.tsx`** (le cœur)

```tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { findPassage } from "@/lib/anchoring";
import { useComments, type Anchor, type CommentRow } from "@/components/review/use-comments";
import { CommentPopover } from "@/components/review/comment-popover";
import { CommentList } from "@/components/review/comment-list";

const CONTEXT = 40;
const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

/** Offsets dans root.textContent → Range DOM (TreeWalker sur les nœuds texte). */
function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0; let startNode: Text | null = null; let startOff = 0; let endNode: Text | null = null; let endOff = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!startNode && start < pos + len) { startNode = n; startOff = start - pos; }
    if (end <= pos + len) { endNode = n; endOff = end - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange(); r.setStart(startNode, startOff); r.setEnd(endNode, endOff); return r;
}

/** Offset d'un point DOM dans root.textContent. */
function offsetOf(root: HTMLElement, node: Node, off: number): number {
  const r = document.createRange(); r.setStart(root, 0); r.setEnd(node, off);
  return r.toString().length;
}

function sectionBefore(root: HTMLElement, offset: number): string {
  let best = ""; let pos = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as HTMLElement | null; n; n = walker.nextNode() as HTMLElement | null) {
    if (!/^H[1-3]$/.test(n.tagName)) continue;
    pos = offsetOf(root, n, 0);
    if (pos <= offset) best = n.textContent ?? ""; else break;
  }
  return best.slice(0, 300);
}

export function ReviewPane({ contentId, body }: { contentId: string; body: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { comments, error, createText, createVoice, update, remove } = useComments(contentId);
  const [pending, setPending] = useState<{ anchor: Anchor; start: number; end: number } | null>(null);
  const [selected, setSelected] = useState<CommentRow | null>(null);
  const [general, setGeneral] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [lost, setLost] = useState<Set<string>>(new Set());
  const hl = useMemo(supportsHighlights, []);

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: body, editable: false, immediatelyRender: false,
  });
  useEffect(() => { editor?.commands.setContent(body); }, [editor, body]);

  // Surlignages (CSS Custom Highlight API) : vert = commentaires ancrés, jaune = sélection en cours
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !editor) return;
    const full = root.textContent ?? "";
    const green = new Highlight(); const lostIds = new Set<string>();
    for (const c of comments) {
      if (!c.quote || c.status !== "open") continue;
      const p = findPassage(full, c.quote, c.prefix, c.suffix);
      const r = p && rangeFromOffsets(root, p.start, p.end);
      if (r) green.add(r); else lostIds.add(c.id);
    }
    setLost(lostIds);
    if (!hl) return;
    CSS.highlights.set("cs-comment", green);
    const yellow = new Highlight();
    if (pending) { const r = rangeFromOffsets(root, pending.start, pending.end); if (r) yellow.add(r); }
    CSS.highlights.set("cs-pending", yellow);
    return () => { CSS.highlights.delete("cs-comment"); CSS.highlights.delete("cs-pending"); };
  }, [comments, pending, editor, body, hl]);

  // Sélection souris → ancrage + popover
  const onMouseUp = useCallback(() => {
    const root = rootRef.current; const sel = window.getSelection();
    if (!root || !sel || sel.isCollapsed || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
    const range = sel.getRangeAt(0);
    const full = root.textContent ?? "";
    const start = offsetOf(root, range.startContainer, range.startOffset);
    const end = offsetOf(root, range.endContainer, range.endOffset);
    if (end <= start) return;
    const quote = full.slice(start, end);
    if (!quote.trim()) return;
    // clic sur un passage déjà commenté → rouvrir
    const hit = comments.find((c) => c.quote && c.status === "open" && (() => { const p = findPassage(full, c.quote, c.prefix, c.suffix); return p && p.start <= start && end <= p.end; })());
    const rect = range.getBoundingClientRect(); const host = root.getBoundingClientRect();
    setPopoverStyle({ top: rect.bottom - host.top + 8, left: Math.max(0, Math.min(rect.left - host.left, host.width - 330)) });
    if (hit) { setSelected(hit); setPending(null); sel.removeAllRanges(); return; }
    setSelected(null); setGeneral(false);
    setPending({
      anchor: { quote: quote.slice(0, 2000), prefix: full.slice(Math.max(0, start - CONTEXT), start), suffix: full.slice(end, end + CONTEXT), section: sectionBefore(root, start) },
      start, end,
    });
    sel.removeAllRanges();
  }, [comments]);

  const close = () => { setPending(null); setSelected(null); setGeneral(false); };
  const anchorForSave = pending?.anchor ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="relative">
        <style>{`::highlight(cs-pending){background:#fde68a;color:inherit} ::highlight(cs-comment){background:#bbf7d0;color:inherit}`}</style>
        <div ref={rootRef} onMouseUp={onMouseUp}
          className="prose prose-invert max-w-none rounded-xl border border-line bg-surface p-5 text-sm leading-relaxed select-text">
          <EditorContent editor={editor} />
        </div>
        {(pending || selected || general) && (
          <CommentPopover
            existing={selected}
            style={general ? { top: 8, right: 8 } : popoverStyle}
            onSaveText={async (text) => {
              if (selected) await update(selected.id, { body: text });
              else await createText(text, general ? null : anchorForSave);
              close();
            }}
            onSaveVoice={async (blob, mime) => { await createVoice(blob, mime, general ? null : anchorForSave); close(); }}
            onResolve={selected ? async () => { await update(selected.id, { status: "resolved" }); close(); } : undefined}
            onDelete={selected ? async () => { await remove(selected.id); close(); } : undefined}
            onClose={close}
          />
        )}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      <CommentList comments={comments} lost={lost} highlightsSupported={hl}
        onSelect={(c) => { setSelected(c); setPending(null); setGeneral(false); setPopoverStyle({ top: 8, right: 8 }); }}
        onGeneral={() => { setGeneral(true); setSelected(null); setPending(null); }} />
    </div>
  );
}
```

Si TypeScript ne connaît pas `Highlight`/`CSS.highlights` (lib DOM trop ancienne), ajouter `src/types/css-highlights.d.ts` :

```ts
declare class Highlight { constructor(...ranges: Range[]); add(r: Range): void; }
interface HighlightRegistry { set(name: string, h: Highlight): void; delete(name: string): void; }
declare namespace CSS { const highlights: HighlightRegistry; }
```

- [ ] **Step 6: Page contenu — onglets + bouton « Appliquer les commentaires »**

Dans `src/app/(app)/contents/[id]/page.tsx` : `const [tab, setTab] = useState<"edit" | "review">("edit");` ; `const reviseJob = jobs.latest("revise");` ; `const { comments } = useComments(id);` (import) ; `const openCount = comments.filter((c) => c.status === "open").length;`

Barre d'onglets au-dessus du corps :

```tsx
      <div className="flex items-center gap-2">
        {(["edit", "review"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${tab === t ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"}`}>
            {t === "edit" ? "Éditer" : `Relire${openCount ? ` (${openCount})` : ""}`}
          </button>
        ))}
        <button type="button" disabled={!openCount || reviseJob?.status === "queued" || reviseJob?.status === "running"}
          onClick={() => jobs.create("revise")}
          className="ml-auto rounded-full border border-line bg-raised px-2.5 py-1 text-[11px] font-medium tracking-wider text-muted uppercase hover:border-line-strong disabled:opacity-50">
          Appliquer les commentaires
        </button>
        <JobStatus job={reviseJob} onRetry={jobs.retry} onCancel={jobs.cancel} renderDone={() => "Commentaires appliqués"} />
      </div>
```

puis rendre `<ContentEditor …/>` seulement si `tab === "edit"`, et `<ReviewPane contentId={id} body={content.body} />` si `tab === "review"`. (L'éditeur démonté ne garde pas de focus → pas d'`editingUntil` fantôme pendant la relecture : une révision agent pendant qu'on relit devient donc `current` et le `ReviewPane` se met à jour via `content.updated`.)

- [ ] **Step 7: Vérification manuelle (checklist)**

`npx tsc --noEmit -p tsconfig.json` → 0 erreur ; `npm run dev` :
1. Ouvrir un contenu avec du texte → onglet Relire → sélectionner une phrase → surlignage jaune + popover → taper → Cmd+Entrée → vert, carte dans la colonne.
2. Cliquer le passage vert → popover en édition → Résoudre → passage dé-surligné, carte grisée dans « traités ».
3. « + Commentaire général » → carte sans quote.
4. 🎙️ Dicter → parler 3 s → Terminer → carte « Transcription en cours… » ; simuler le worker : `curl -H "authorization: Bearer cs_…" -o /tmp/a.webm http://127.0.0.1:3003/api/jobs/<job>/audio` (fichier non vide) puis `complete_job {text:"…"}` via MCP → le texte apparaît dans la carte et le popover sans recharger.
5. Modifier le corps dans Éditer (supprimer la phrase commentée) → retour Relire → « ⚠️ passage introuvable » sur la carte, pas de surlignage, pas d'erreur.
6. « Appliquer les commentaires » désactivé sans commentaire open ; actif sinon ; crée un job `revise` visible (queued).

- [ ] **Step 8: Commit**

```bash
git add src/components/review "src/app/(app)/contents/[id]/page.tsx" src/types 2>/dev/null
git commit -m "feat(relecture): onglet Relire — surlignage (CSS Highlights), popover texte/dictée, colonne de commentaires, Appliquer les commentaires"
```

---

### Task 16: Documentation — README + `.env.example` + note de déploiement

**Files:**
- Modify: `README.md` (nouvelle section après « Brancher ton agent (MCP) »), `docs/specs/2026-08-22-cockpit-agent-design.md` (statut → « implémenté »)

- [ ] **Step 1: README — section « Un worker externe : jobs, publications, relecture »**

Contenu à écrire (en français, concis) :
- Le modèle : l'UI pose des jobs (Rédiger, Publier, Appliquer les commentaires, Re-synchroniser) ; un worker branché en MCP fait `list_jobs(status:"queued")` → `claim_job` → travail → `complete_job`/`fail_job`, `heartbeat_job` toutes les 60 s sur les travaux longs ; un workspace sans worker voit ses jobs « en attente d'un agent ».
- Les kinds intégrés et leurs effets (tableau : write, publish, sync, revise, transcribe) + « tout autre kind est libre ».
- Publications : `link_publication` après publication, hook de re-sync, `mark_synced`, carte.
- Relecture : onglet Relire, `list_comments`/`resolve_comment`, dictée → job `transcribe` + `GET /api/jobs/:id/audio` en Bearer.
- Un squelette de worker, à coller tel quel dans le README :

```js
// worker.mjs — sonde le studio toutes les 30 s, un job à la fois (client MCP = @modelcontextprotocol/sdk)
const tool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
while (true) {
  const [job] = await tool("list_jobs", { status: "queued" });
  if (!job) { await sleep(30_000); continue; }
  const claimed = await tool("claim_job", { job_id: job.id, worker_label: "mon-worker" });
  if (claimed.error) continue;                       // un autre worker l'a pris
  const hb = setInterval(() => tool("heartbeat_job", { job_id: job.id }), 60_000);
  try {
    switch (job.kind) {
      case "write":      /* enquête + rédaction → create_content_draft, update_content, set_content_status(review) */ break;
      case "publish":    /* POST vers ta cible → link_publication, set_content_status(published), update_idea(done) */ break;
      case "sync":       /* re-publie le corps courant → mark_synced */ break;
      case "revise":     /* list_comments(open) → réécrit → update_content → resolve_comment(applied) */ break;
      case "transcribe": /* GET /api/jobs/:id/audio (Bearer) → whisper → complete_job({ text }) */ break;
      default:           throw new Error(`kind inconnu : ${job.kind}`);
    }
    await tool("complete_job", { job_id: job.id, result: { /* … */ } });
  } catch (e) {
    await tool("fail_job", { job_id: job.id, error: String(e.message).slice(0, 2000) });
  } finally { clearInterval(hb); }
}
```
- Sécurité : aucune exécution côté serveur ; bornes ; la seule route binaire au token.

- [ ] **Step 2: Statut de la spec**

Dans `docs/specs/2026-08-22-cockpit-agent-design.md`, `**Statut**` → `implémenté (plan docs/plans/2026-08-22-cockpit-agent.md)`.

- [ ] **Step 3: Suite complète + commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add README.md docs/specs/2026-08-22-cockpit-agent-design.md
git commit -m "docs: worker externe — jobs, publications, relecture & dictée (README + statut de la spec)"
```

---

## Déploiement (hors tâches, pour mémoire)

Sur le VPS : `ssh mattioo@144.76.224.57 '~/content-studio/deploy/update.sh'` (fetch → rebase → build → healthcheck ; la migration s'applique au démarrage du conteneur). Vérifier ensuite `GET /api/mcp` avec le token (401 attendu sans, 200 avec) et l'UI.
