# Vague « dictée partout » — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dicter au lieu de taper dans toutes les zones de saisie de content-studio, transcription locale par mlx-whisper via un worker sur le Mac, en asynchrone, sans jamais perdre une dictée.

**Architecture:** L'audio part du navigateur vers `POST /api/dictations` (ligne `dictations` + audio bytea + job `transcribe` ciblant la dictée). Un worker unique `scripts/worker.mjs` (ex-`extract-worker`) est notifié en temps réel par `/api/events` (Bearer MCP), récupère l'audio, le passe à un processus Python résident (mlx-whisper) et rend le texte par `complete_job({ text })`. Le texte arrive dans le champ d'origine par SSE (`dictation.updated`) grâce à un micro intégré aux primitives `Input`/`Textarea` et à l'éditeur tiptap ; une page « Dictées » liste tout ce qui est en attente / prêt / en échec.

**Tech Stack:** Next.js 16 (App Router, route handlers), Drizzle + Postgres (migration via `drizzle-kit`), mcp-handler + `@modelcontextprotocol/sdk` 1.30 (worker), lucide-react (icônes), tiptap, vitest. Worker : Node ESM + Python (venv `~/.claude/tools/yt-transcript/venv`, mlx-whisper) + ffmpeg.

**Spec:** `docs/specs/2026-09-04-dictation-design.md`

## Global Constraints

- **Migration SQL** : cette vague en a UNE (tables `dictations` + `dictation_audio`) : `npm run db:generate` produit `drizzle/0008_*.sql` à committer. Les tests l'appliquent seuls (`tests/setup.global.ts` lance `drizzle-kit migrate` sur `content_studio_test`). Pour la base de dev : `DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npm run db:migrate`.
- Bornes exactes : `MAX_AUDIO_BYTES = 16 * 1024 * 1024`, `MAX_RECORD_MS = 3 * 60_000`, `MAX_FIELD_KEY_LENGTH = 200`, `MAX_DICTATION_TEXT_LENGTH = 200_000`. `AUDIO_MIMES` inchangée (webm, webm;codecs=opus, mp4, ogg, wav, mpeg).
- Tests : TOUJOURS `npx vitest run <fichier>` (jamais `npx vitest` nu). Base de dev requise. Typecheck : `npx tsc --noEmit` (timeout 120 s).
- Git : commits par **pathspec explicite** (jamais `git add -A`). Chaque message de commit se termine par la ligne :
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
- Imports : `dictations.ts` importe `jobs.ts` STATIQUEMENT ; `jobs.ts` n'importe `dictations.ts` que DYNAMIQUEMENT (`await import(...)`) — même règle que sources/comments/publications (pas de cycle).
- Copie UI en français, commentaires de code en français, apostrophes JSX en `&apos;`. Pas d'emoji dans les composants (icônes lucide).
- Événement : `{ type: "dictation.updated"; dictationId: string; fieldKey: string; status: string }` ; `job.updated` gagne `"dictation"` dans `targetType`.
- Déviations assumées par ce plan (à reporter dans la spec en Task 9) : pas de micro sur l'éditeur de relecture (il est `editable: false` — les commentaires se dictent via la Textarea du popover) ; le « tiroir » est une page `/dictations` + entrée de barre latérale avec badge.

---

### Task 1: `src/lib/audio.ts` — bornes audio et lecteur de corps partagés

**Files:**
- Create: `src/lib/audio.ts`
- Modify: `src/lib/comments.ts:12-13` (constantes → ré-export), `src/lib/comments.ts:75-78` (validation mime via `isSupportedAudioMime`)
- Modify: `src/app/api/contents/[id]/comments/audio/route.ts` (supprimer `readBodyBounded` local, importer depuis `@/lib/audio`)
- Test: `tests/audio.test.ts`

**Interfaces:**
- Consomme : rien de nouveau.
- Produit : `MAX_AUDIO_BYTES`, `AUDIO_MIMES`, `isSupportedAudioMime(mime: string): boolean`, `readBodyBounded(req: NextRequest, max: number): Promise<Buffer | null>` (null = dépassement). `comments.ts` continue d'exporter `MAX_AUDIO_BYTES` et `AUDIO_MIMES` (tests existants).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/audio.test.ts
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { isSupportedAudioMime, readBodyBounded, MAX_AUDIO_BYTES, AUDIO_MIMES } from "@/lib/audio";

const post = (body: BodyInit | null) =>
  new NextRequest("http://localhost:3003/api/x", { method: "POST", body, headers: { "content-type": "audio/webm" } });

describe("lib/audio — bornes partagées", () => {
  it("isSupportedAudioMime ignore les paramètres et refuse l'inconnu", () => {
    expect(isSupportedAudioMime("audio/webm;codecs=opus")).toBe(true);
    expect(isSupportedAudioMime("audio/mp4")).toBe(true);
    expect(isSupportedAudioMime("text/plain")).toBe(false);
    expect(AUDIO_MIMES.length).toBeGreaterThan(0);
    expect(MAX_AUDIO_BYTES).toBe(16 * 1024 * 1024);
  });

  it("readBodyBounded : sous la borne → Buffer, au-delà → null, sans corps → vide", async () => {
    expect((await readBodyBounded(post("x".repeat(10)), 10))?.length).toBe(10);
    expect(await readBodyBounded(post("x".repeat(11)), 10)).toBeNull();
    expect((await readBodyBounded(post(null), 10))?.length).toBe(0);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/audio.test.ts`
Attendu : FAIL — module `@/lib/audio` introuvable.

- [ ] **Step 3: Implémenter**

Créer `src/lib/audio.ts` :

```ts
import type { NextRequest } from "next/server";

// Bornes audio PARTAGÉES par la dictée des commentaires (legacy) et la dictée
// des champs (vague « dictée partout ») : une seule règle, un seul endroit.
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const AUDIO_MIMES = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"];

/** Compare sur le type sans paramètres : `audio/webm;codecs=opus` → `audio/webm`. */
export function isSupportedAudioMime(mime: string): boolean {
  const base = mime.split(";")[0].trim();
  return AUDIO_MIMES.some((m) => m.split(";")[0] === base);
}

/**
 * Lit le corps par morceaux et coupe DÈS que le cumul dépasse `max`, sans
 * jamais tamponner plus que max + un chunk : un upload chunké/streamé sans
 * (ou avec un) content-length mensonger ne doit pas forcer à bufferiser tout
 * le flux avant de le rejeter (mémoire non bornée sinon). null = dépassement
 * (→ 413 côté appelant) ; corps absent = vide (→ "audio vide" côté lib, 400).
 */
export async function readBodyBounded(req: NextRequest, max: number): Promise<Buffer | null> {
  const body = req.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
```

Dans `src/lib/comments.ts` : remplacer les deux lignes `export const MAX_AUDIO_BYTES = …` et `export const AUDIO_MIMES = […]` par :

```ts
import { MAX_AUDIO_BYTES, isSupportedAudioMime } from "@/lib/audio";
export { MAX_AUDIO_BYTES, AUDIO_MIMES } from "@/lib/audio";
```

(placer l'`import` avec les autres imports en tête de fichier, l'`export …from` juste sous les constantes restantes) et dans `createVoiceComment` remplacer :

```ts
  const mime = input.mime.split(";")[0].trim();
  if (!AUDIO_MIMES.some((m) => m.split(";")[0] === mime)) throw new Error(`mime audio non supporté : ${input.mime}`);
```
par
```ts
  if (!isSupportedAudioMime(input.mime)) throw new Error(`mime audio non supporté : ${input.mime}`);
```

Dans `src/app/api/contents/[id]/comments/audio/route.ts` : supprimer la fonction locale `readBodyBounded` (et son commentaire) et remplacer l'import par :

```ts
import { createVoiceComment } from "@/lib/comments";
import { MAX_AUDIO_BYTES, isSupportedAudioMime, readBodyBounded } from "@/lib/audio";
```
et la vérification mime par `if (!isSupportedAudioMime(mime))`.

- [ ] **Step 4: Vérifier le passage + non-régression**

Run: `npx vitest run tests/audio.test.ts tests/comments.test.ts tests/comments-routes.test.ts tests/mcp-comments.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio.ts src/lib/comments.ts "src/app/api/contents/[id]/comments/audio/route.ts" tests/audio.test.ts
git commit -m "refactor: bornes audio et lecteur de corps borné partagés (lib/audio)"
```

---

### Task 2: Modèle — tables `dictations`, migration, lib `dictations.ts`, jobs cible `dictation`

**Files:**
- Modify: `src/lib/db/schema.ts` (enum `agentJobs.targetType` + deux tables en fin de fichier)
- Create: `drizzle/0008_*.sql` (généré par `npm run db:generate`)
- Modify: `src/lib/events.ts` (union)
- Create: `src/lib/dictations.ts`
- Modify: `src/lib/jobs.ts` (`JobTargetType`, `assertTarget`, `targetTitle`, garde `completeJob`, `applyFailureEffects`)
- Modify: `src/hooks/use-jobs.ts:15` (union `targetType`)
- Test: `tests/dictations.test.ts`

**Interfaces:**
- Consomme : `MAX_AUDIO_BYTES`, `isSupportedAudioMime` (Task 1) ; `createJob`, `listJobs`, `retryJob`, `cancelJob` (jobs.ts).
- Produit (lib `dictations.ts`) : `type Dictation` ; `createDictation(ws, { audio: Buffer; mime: string; fieldKey?: string; createdBy?: string }) → { dictation, job }` ; `getDictation(ws, id) → Dictation | null` ; `getDictationAudio(ws, id) → { mime, bytes, size } | null` ; `listDictations(ws, { status?, fieldKey?, open?: boolean, limit? })` (open = pending OU done non consommée) ; `applyDictation(ws, id, text)` ; `failDictation(ws, id, reason)` ; `consumeDictation(ws, id)` ; `retryDictation(ws, id)` ; `deleteDictation(ws, id) → boolean` ; constantes `MAX_FIELD_KEY_LENGTH = 200`, `MAX_DICTATION_TEXT_LENGTH = 200_000`. Messages d'erreur : « audio vide », « audio trop gros (max … octets) », « mime audio non supporté : … », « field_key trop long (max 200 caractères) », « réessai refusé : … », « text trop long (max 200000 caractères) ».
- Jobs : `createJob` accepte `targetType: "dictation"` ; `completeJob` d'un `transcribe`/dictation exige `result.text` string et pose le texte ; échecs → `failDictation`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// tests/dictations.test.ts
import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import {
  createDictation, getDictation, getDictationAudio, listDictations, applyDictation,
  failDictation, consumeDictation, retryDictation, deleteDictation,
  MAX_FIELD_KEY_LENGTH, MAX_DICTATION_TEXT_LENGTH,
} from "@/lib/dictations";
import { claimJob, completeJob, failJob, cancelJob, listJobs } from "@/lib/jobs";
import { bus, type WorkspaceEvent } from "@/lib/events";

const audio = () => Buffer.from("fake-opus-bytes");

describe("dictations — création et bornes", () => {
  it("createDictation : ligne pending + audio + job transcribe ciblant la dictée", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, {
      audio: audio(), mime: "audio/webm;codecs=opus", fieldKey: "idea:42:notes", createdBy: ws.userId,
    });
    expect(dictation.status).toBe("pending");
    expect(dictation.fieldKey).toBe("idea:42:notes");
    expect(job.kind).toBe("transcribe");
    expect(job.targetType).toBe("dictation");
    expect(job.targetId).toBe(dictation.id);
    expect(job.payload).toMatchObject({ field_key: "idea:42:notes", mime: "audio/webm;codecs=opus", size: audio().length });
    const stored = await getDictationAudio(ws.workspaceId, dictation.id);
    expect(stored?.size).toBe(audio().length);
    expect(stored?.mime).toBe("audio/webm;codecs=opus");
  });

  it("refuse audio vide, trop gros, mime inconnu, field_key trop long", async () => {
    const ws = await signUpTestUser();
    await expect(createDictation(ws.workspaceId, { audio: Buffer.alloc(0), mime: "audio/webm" })).rejects.toThrow(/audio vide/);
    await expect(createDictation(ws.workspaceId, { audio: Buffer.alloc(16 * 1024 * 1024 + 1), mime: "audio/webm" })).rejects.toThrow(/trop gros/);
    await expect(createDictation(ws.workspaceId, { audio: audio(), mime: "text/plain" })).rejects.toThrow(/mime audio non supporté/);
    await expect(createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k".repeat(MAX_FIELD_KEY_LENGTH + 1) })).rejects.toThrow(/field_key trop long/);
  });
});

describe("dictations — cycle transcribe", () => {
  it("complete_job avec result.text → done, texte posé, audio purgé ; sans text → refusé", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "f" });
    await claimJob(ws.workspaceId, job.id, "test-worker");
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/result.text requis/);
    const done = await completeJob(ws.workspaceId, job.id, { text: "Bonjour, ceci est une dictée." });
    expect(done?.status).toBe("done");
    const d = await getDictation(ws.workspaceId, dictation.id);
    expect(d?.status).toBe("done");
    expect(d?.text).toBe("Bonjour, ceci est une dictée.");
    expect(await getDictationAudio(ws.workspaceId, dictation.id)).toBeNull();
  });

  it("fail_job / cancel_job → failed avec raison, audio conservé ; jamais sur une dictée done", async () => {
    const ws = await signUpTestUser();
    const a = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "a" });
    await claimJob(ws.workspaceId, a.job.id, "w");
    await failJob(ws.workspaceId, a.job.id, "ffmpeg absent");
    const fa = await getDictation(ws.workspaceId, a.dictation.id);
    expect(fa?.status).toBe("failed");
    expect(fa?.error).toBe("ffmpeg absent");
    expect(await getDictationAudio(ws.workspaceId, a.dictation.id)).not.toBeNull();

    const b = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "b" });
    await cancelJob(ws.workspaceId, b.job.id);
    expect((await getDictation(ws.workspaceId, b.dictation.id))?.status).toBe("failed");

    await applyDictation(ws.workspaceId, b.dictation.id, "texte");
    expect(await failDictation(ws.workspaceId, b.dictation.id, "trop tard")).toBeNull();
    expect((await getDictation(ws.workspaceId, b.dictation.id))?.status).toBe("done");
  });

  it("applyDictation refuse un texte au-delà de MAX_DICTATION_TEXT_LENGTH", async () => {
    const ws = await signUpTestUser();
    const { dictation } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm" });
    await expect(applyDictation(ws.workspaceId, dictation.id, "x".repeat(MAX_DICTATION_TEXT_LENGTH + 1))).rejects.toThrow(/text trop long/);
  });

  it("retryDictation : failed → pending + job requeued (attempts+1) ; refus si non failed ; null si introuvable", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "r" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const retried = await retryDictation(ws.workspaceId, dictation.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.error).toBeNull();
    const jobs = await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: dictation.id });
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].attempts).toBe(1);
    await expect(retryDictation(ws.workspaceId, dictation.id)).rejects.toThrow(/réessai refusé/);
    expect(await retryDictation(ws.workspaceId, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("consumeDictation idempotent ; listDictations open = pending + done non consommée du field_key", async () => {
    const ws = await signUpTestUser();
    const p = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const d = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const c = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const other = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "autre" });
    await applyDictation(ws.workspaceId, d.dictation.id, "prête");
    await applyDictation(ws.workspaceId, c.dictation.id, "déjà lue");
    const first = await consumeDictation(ws.workspaceId, c.dictation.id);
    const second = await consumeDictation(ws.workspaceId, c.dictation.id);
    expect(first?.consumedAt).not.toBeNull();
    expect(second?.consumedAt?.getTime()).toBe(first?.consumedAt?.getTime());

    const open = await listDictations(ws.workspaceId, { fieldKey: "k", open: true });
    expect(open.map((x) => x.id).sort()).toEqual([p.dictation.id, d.dictation.id].sort());
    expect((await listDictations(ws.workspaceId, { status: "pending" })).map((x) => x.id)).toContain(other.dictation.id);
    expect(await listDictations(ws.workspaceId, { limit: 2 })).toHaveLength(2);
    // jamais l'audio dans une liste
    expect("bytes" in open[0]).toBe(false);
  });

  it("deleteDictation : ligne + audio supprimés, job queued annulé, événement deleted", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "del" });
    const events: WorkspaceEvent[] = [];
    const off = bus.subscribe(ws.workspaceId, (e) => events.push(e));
    try {
      expect(await deleteDictation(ws.workspaceId, dictation.id)).toBe(true);
    } finally { off(); }
    expect(await getDictation(ws.workspaceId, dictation.id)).toBeNull();
    expect(await getDictationAudio(ws.workspaceId, dictation.id)).toBeNull();
    const [j] = await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: dictation.id });
    expect(j.status).toBe("cancelled");
    expect(events.some((e) => e.type === "dictation.updated" && e.status === "deleted" && e.dictationId === dictation.id)).toBe(true);
    expect(await deleteDictation(ws.workspaceId, dictation.id)).toBe(false);
  });
});

describe("dictations — cloisonnement workspace", () => {
  it("une dictée de A est invisible et intouchable depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const { dictation } = await createDictation(a.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "x" });
    expect(await getDictation(b.workspaceId, dictation.id)).toBeNull();
    expect(await getDictationAudio(b.workspaceId, dictation.id)).toBeNull();
    expect(await applyDictation(b.workspaceId, dictation.id, "vol")).toBeNull();
    expect(await failDictation(b.workspaceId, dictation.id, "vol")).toBeNull();
    expect(await consumeDictation(b.workspaceId, dictation.id)).toBeNull();
    expect(await deleteDictation(b.workspaceId, dictation.id)).toBe(false);
    expect((await listDictations(b.workspaceId, {})).map((x) => x.id)).not.toContain(dictation.id);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/dictations.test.ts`
Attendu : FAIL — module `@/lib/dictations` introuvable.

- [ ] **Step 3: Schéma + migration**

Dans `src/lib/db/schema.ts`, table `agentJobs` :

```ts
  targetType: text("target_type", { enum: ["idea", "content", "comment", "source", "dictation"] }).notNull(),
```

En fin de fichier (après `assets`) :

```ts
// ---- dictées (vague « dictée partout ») -----------------------------------
// Une dictée = un audio déposé depuis n'importe quel champ de l'UI, transcrit
// par le worker local (job transcribe, cible dictation). field_key identifie
// le champ d'origine (opaque pour le serveur) ; consumed_at = le champ a
// inséré le texte. L'audio est purgé dès que la transcription réussit, gardé
// tant qu'un réessai est possible.
export const dictations = pgTable("dictations", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "done", "failed"] }).notNull().default("pending"),
  text: text("text").notNull().default(""),
  error: text("error"),
  fieldKey: text("field_key").notNull().default(""),
  consumedAt: timestamp("consumed_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("dictations_ws_status").on(t.workspaceId, t.status),
  index("dictations_ws_field").on(t.workspaceId, t.fieldKey),
]);

// Même pattern que comment_audio : pas de workspace_id, cloisonné par la
// dictée parente — toute lecture passe par dictations.workspace_id d'abord.
export const dictationAudio = pgTable("dictation_audio", {
  dictationId: uuid("dictation_id").primaryKey()
    .references(() => dictations.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  bytes: customType<{ data: Buffer; driverData: Buffer }>({ dataType() { return "bytea"; } })("bytes").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

Générer la migration : `npm run db:generate` → un fichier `drizzle/0008_<nom>.sql` (créer les deux tables + index + FK). Vérifier son contenu (`cat drizzle/0008_*.sql`) : deux `CREATE TABLE`, aucun `DROP`.

- [ ] **Step 4: Événements + hook**

`src/lib/events.ts` : dans `job.updated`, `targetType: "idea" | "content" | "comment" | "source" | "dictation"` ; ajouter à l'union :

```ts
  // vague « dictée partout » : transitions d'une dictée (pending → done/failed,
  // réessai, consommation par le champ, suppression → "deleted")
  | { type: "dictation.updated"; dictationId: string; fieldKey: string; status: string }
```

`src/hooks/use-jobs.ts` : `targetType: "idea" | "content" | "comment" | "source" | "dictation"`.

- [ ] **Step 5: Lib `src/lib/dictations.ts`**

```ts
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

/** Le champ a inséré le texte. Idempotent : un second appel rend la ligne telle quelle. */
export async function consumeDictation(workspaceId: string, id: string) {
  const [row] = await db.update(dictations)
    .set({ consumedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(dictations.id, id), eq(dictations.workspaceId, workspaceId), isNull(dictations.consumedAt)))
    .returning();
  if (row) { publish(row, "consumed"); return row; }
  return getDictation(workspaceId, id);
}

/** failed → pending, et repose le job (retry du dernier failed, sinon un neuf). */
export async function retryDictation(workspaceId: string, id: string) {
  const existing = await getDictation(workspaceId, id);
  if (!existing) return null;
  if (existing.status !== "failed") throw new Error(`réessai refusé : dictée en statut ${existing.status}`);
  if (!(await getDictationAudio(workspaceId, id))) throw new Error("réessai refusé : audio absent");
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
```

- [ ] **Step 6: `src/lib/jobs.ts`**

1. Import : ajouter `dictations` à l'import du schéma.
2. `export type JobTargetType = "idea" | "content" | "comment" | "source" | "dictation";`
3. `assertTarget` : avant le `throw` final,
```ts
  } else if (targetType === "dictation") {
    const [row] = await db.select({ id: dictations.id }).from(dictations)
      .where(and(eq(dictations.id, targetId), eq(dictations.workspaceId, workspaceId)));
    if (row) return;
  }
```
4. `targetTitle` : ajouter avant `else null end` :
```
      when agent_jobs.target_type = 'dictation' then (select 'Dictée ' || d.field_key from dictations d where d.id = agent_jobs.target_id)
```
5. `completeJob` : remplacer la garde transcribe existante par
```ts
  // Un transcribe (commentaire OU dictée) sans result.text ne doit jamais
  // passer done avec une cible qui resterait pending pour toujours : vérifié
  // AVANT finish, le job reste running (retry possible).
  if (current?.kind === "transcribe" && (current.targetType === "comment" || current.targetType === "dictation")
    && typeof result.text !== "string")
    throw new Error("result.text requis pour un job transcribe");
```
et après l'effet post-commit `transcribe`/comment existant, ajouter :
```ts
  if (row && row.kind === "transcribe" && row.targetType === "dictation") {
    try {
      // Import dynamique : dictations.ts importe jobs.ts (createJob).
      const { applyDictation } = await import("@/lib/dictations");
      await applyDictation(workspaceId, row.targetId, result.text as string);
    } catch (e) {
      console.error("applyDictation a échoué après completeJob", e);
    }
  }
```
6. `applyFailureEffects` : ajouter
```ts
  if (job.kind === "transcribe" && job.targetType === "dictation") {
    const { failDictation } = await import("@/lib/dictations");
    await failDictation(job.workspaceId, job.targetId, message);
  }
```

- [ ] **Step 7: Vérifier le passage + non-régression**

Run: `npx vitest run tests/dictations.test.ts tests/jobs.test.ts tests/jobs-extract.test.ts tests/comments.test.ts tests/schema.test.ts`
Attendu : PASS (la migration 0008 est appliquée par le setup global).

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/schema.ts drizzle/ src/lib/events.ts src/lib/dictations.ts src/lib/jobs.ts src/hooks/use-jobs.ts tests/dictations.test.ts
git commit -m "feat: dictées — tables, lib, job transcribe ciblant une dictée (migration 0008)"
```

---

### Task 3: Routes — `/api/dictations`, audio worker, `/api/events` en Bearer

**Files:**
- Create: `src/app/api/dictations/route.ts` (POST, GET)
- Create: `src/app/api/dictations/[id]/route.ts` (GET, DELETE)
- Create: `src/app/api/dictations/[id]/retry/route.ts` (POST)
- Create: `src/app/api/dictations/[id]/consume/route.ts` (POST)
- Modify: `src/app/api/jobs/[id]/audio/route.ts`
- Modify: `src/app/api/events/route.ts`
- Test: `tests/dictations-routes.test.ts`, `tests/events-bearer.test.ts`

**Interfaces:**
- Consomme : lib `dictations.ts` (Task 2), `readBodyBounded`/`isSupportedAudioMime`/`MAX_AUDIO_BYTES` (Task 1), helpers de test `signUpTestUser`, `authedReq`, `req`, `generateMcpToken`.
- Produit : contrats HTTP consommés par le hook (Task 5), la page (Task 8) et le worker (Task 4). `POST /api/dictations?field_key=` → 201 `{ id, status, fieldKey }`. `GET /api/dictations?status=&field_key=&open=1&limit=` → liste. `GET /api/dictations/[id]` → dictée. `DELETE` → 204. `POST …/retry` → 200 | 409 | 404. `POST …/consume` → 200. `GET /api/events` avec `Authorization: Bearer cs_…` → flux SSE du workspace du token.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// tests/dictations-routes.test.ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { POST as createRoute, GET as listRoute } from "@/app/api/dictations/route";
import { GET as getRoute, DELETE as deleteRoute } from "@/app/api/dictations/[id]/route";
import { POST as retryRoute } from "@/app/api/dictations/[id]/retry/route";
import { POST as consumeRoute } from "@/app/api/dictations/[id]/consume/route";
import { GET as audioRoute } from "@/app/api/jobs/[id]/audio/route";
import { createDictation, applyDictation, getDictation } from "@/lib/dictations";
import { claimJob, failJob, listJobs } from "@/lib/jobs";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const audioInit = (bytes: Uint8Array, mime = "audio/webm") => ({ method: "POST", headers: { "content-type": mime }, body: bytes });

describe("POST /api/dictations", () => {
  it("201 avec field_key, job transcribe créé ; 401 sans session ; 415 mime ; 400 vide ; 413 trop gros", async () => {
    const ws = await signUpTestUser();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect((await createRoute(req("/api/dictations", audioInit(bytes)))).status).toBe(401);

    const r = await createRoute(await authedReq(ws, "/api/dictations?field_key=idea%3A1%3Anotes", audioInit(bytes)));
    expect(r.status).toBe(201);
    const { id, status, fieldKey } = await r.json();
    expect(status).toBe("pending");
    expect(fieldKey).toBe("idea:1:notes");
    expect(await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id })).toHaveLength(1);

    expect((await createRoute(await authedReq(ws, "/api/dictations", audioInit(bytes, "text/plain")))).status).toBe(415);
    expect((await createRoute(await authedReq(ws, "/api/dictations", audioInit(new Uint8Array(0))))).status).toBe(400);
    const big = await authedReq(ws, "/api/dictations", { method: "POST", headers: { "content-type": "audio/webm", "content-length": String(16 * 1024 * 1024 + 1) }, body: bytes });
    expect((await createRoute(big)).status).toBe(413);
  });
});

describe("GET/DELETE /api/dictations, retry, consume", () => {
  it("liste (sans audio), open par field_key, get, consume, retry, delete, cloisonnement", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: Buffer.from("abc"), mime: "audio/webm", fieldKey: "k" });
    const { dictation: ready } = await createDictation(ws.workspaceId, { audio: Buffer.from("abc"), mime: "audio/webm", fieldKey: "k" });
    await applyDictation(ws.workspaceId, ready.id, "texte prêt");

    const list = await listRoute(await authedReq(ws, "/api/dictations"));
    expect(list.status).toBe(200);
    const rows = await list.json();
    expect(rows.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([dictation.id, ready.id]));
    expect("bytes" in rows[0]).toBe(false);

    const open = await (await listRoute(await authedReq(ws, "/api/dictations?field_key=k&open=1"))).json();
    expect(open.map((d: { id: string }) => d.id).sort()).toEqual([dictation.id, ready.id].sort());

    expect((await getRoute(await authedReq(ws, `/api/dictations/${ready.id}`), params(ready.id))).status).toBe(200);
    expect((await getRoute(await authedReq(autre, `/api/dictations/${ready.id}`), params(ready.id))).status).toBe(404);

    const consumed = await consumeRoute(await authedReq(ws, `/api/dictations/${ready.id}/consume`, { method: "POST" }), params(ready.id));
    expect(consumed.status).toBe(200);
    expect((await consumed.json()).consumedAt).not.toBeNull();
    expect((await (await listRoute(await authedReq(ws, "/api/dictations?field_key=k&open=1"))).json()).map((d: { id: string }) => d.id)).toEqual([dictation.id]);

    expect((await retryRoute(await authedReq(ws, `/api/dictations/${dictation.id}/retry`, { method: "POST" }), params(dictation.id))).status).toBe(409);
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const retried = await retryRoute(await authedReq(ws, `/api/dictations/${dictation.id}/retry`, { method: "POST" }), params(dictation.id));
    expect(retried.status).toBe(200);
    expect((await retried.json()).status).toBe("pending");

    expect((await deleteRoute(await authedReq(autre, `/api/dictations/${dictation.id}`), params(dictation.id))).status).toBe(404);
    expect((await deleteRoute(await authedReq(ws, `/api/dictations/${dictation.id}`), params(dictation.id))).status).toBe(204);
    expect(await getDictation(ws.workspaceId, dictation.id)).toBeNull();
  });
});

describe("GET /api/jobs/[id]/audio — dictée", () => {
  it("sert l'audio d'un job transcribe/dictation du workspace du token ; 404 sinon", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const { token: tokenAutre } = await generateMcpToken(autre.workspaceId, "w");
    const { job } = await createDictation(ws.workspaceId, { audio: Buffer.from("opus!"), mime: "audio/webm", fieldKey: "a" });

    const ok = await audioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), params(job.id));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/webm");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("opus!");

    expect((await audioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${tokenAutre}` } }), params(job.id))).status).toBe(404);
    expect((await audioRoute(req(`/api/jobs/${job.id}/audio`), params(job.id))).status).toBe(401);
  });
});
```

```ts
// tests/events-bearer.test.ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { GET as eventsRoute } from "@/app/api/events/route";
import { bus } from "@/lib/events";

describe("GET /api/events — token MCP en Bearer", () => {
  it("401 sans token/invalide ; 200 + flux du workspace du token", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "worker");
    expect((await eventsRoute(req("/api/events"))).status).toBe(401);
    expect((await eventsRoute(req("/api/events", { headers: { authorization: "Bearer cs_deadbeef" } }))).status).toBe(401);

    const res = await eventsRoute(req("/api/events", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toContain("connected");
    bus.publish(ws.workspaceId, { type: "idea.created", ideaId: "evt-du-bon-workspace" });
    expect(dec.decode((await reader.read()).value)).toContain("evt-du-bon-workspace");
    await reader.cancel();
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/dictations-routes.test.ts tests/events-bearer.test.ts`
Attendu : FAIL — modules de routes introuvables ; `/api/events` répond 401 au Bearer.

- [ ] **Step 3: Implémenter**

`src/app/api/dictations/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createDictation, listDictations } from "@/lib/dictations";
import { MAX_AUDIO_BYTES, isSupportedAudioMime, readBodyBounded } from "@/lib/audio";

/** Dépôt d'une dictée : le corps de la requête EST l'audio, le champ d'origine passe en query. */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const mime = (req.headers.get("content-type") ?? "").trim();
    if (!isSupportedAudioMime(mime)) return NextResponse.json({ error: "type audio non supporté" }, { status: 415 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const buf = await readBodyBounded(req, MAX_AUDIO_BYTES);
    if (buf === null) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const fieldKey = req.nextUrl.searchParams.get("field_key") ?? "";
    const { dictation } = await createDictation(workspaceId, { audio: buf, mime, fieldKey, createdBy: userId });
    return NextResponse.json({ id: dictation.id, status: dictation.status, fieldKey: dictation.fieldKey }, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("audio vide")) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("trop gros")) return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof Error && e.message.includes("mime")) return NextResponse.json({ error: e.message }, { status: 415 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** Liste sans audio. `open=1` + `field_key` = ce qu'un champ attend encore (pending, ou done non consommée). */
export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const rows = await listDictations(workspaceId, {
      status: status === "pending" || status === "done" || status === "failed" ? status : undefined,
      fieldKey: sp.get("field_key") ?? undefined,
      open: sp.get("open") === "1",
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    });
    return NextResponse.json(rows);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
```

`src/app/api/dictations/[id]/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getDictation, deleteDictation } from "@/lib/dictations";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const d = await getDictation(workspaceId, (await params).id);
    if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(d);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const ok = await deleteDictation(workspaceId, (await params).id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
```

`src/app/api/dictations/[id]/retry/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { retryDictation } from "@/lib/dictations";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const d = await retryDictation(workspaceId, (await params).id);
    if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(d);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("réessai refusé")) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
```

`src/app/api/dictations/[id]/consume/route.ts` :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { consumeDictation } from "@/lib/dictations";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const d = await consumeDictation(workspaceId, (await params).id);
    if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(d);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
```

`src/app/api/jobs/[id]/audio/route.ts` — remplacer le corps de `GET` :

```ts
  const auth = await resolveMcpToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const job = await getJob(auth.workspaceId, (await params).id);
  if (!job || job.kind !== "transcribe") return NextResponse.json({ error: "not found" }, { status: 404 });
  // Deux cibles : le commentaire vocal (legacy) et la dictée d'un champ.
  const audio = job.targetType === "comment"
    ? await getCommentAudio(auth.workspaceId, job.targetId)
    : job.targetType === "dictation"
      ? await getDictationAudio(auth.workspaceId, job.targetId)
      : null;
  if (!audio) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(audio.bytes), {
    status: 200,
    headers: { "content-type": audio.mime, "content-length": String(audio.bytes.length), "cache-control": "no-store" },
  });
```
(avec `import { getDictationAudio } from "@/lib/dictations";` et le commentaire de tête mis à jour : « … l'audio du commentaire OU de la dictée visé par un job transcribe … »).

`src/app/api/events/route.ts` — remplacer `const { workspaceId } = await requireWorkspace(req.headers);` par :

```ts
    // Deux clients : le navigateur (session) et un worker (token MCP en
    // Bearer) qui veut voir les jobs queued sans attendre son prochain poll.
    const authz = req.headers.get("authorization");
    let workspaceId: string;
    if (authz) {
      const resolved = await resolveMcpToken(authz);
      if (!resolved) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      workspaceId = resolved.workspaceId;
    } else {
      ({ workspaceId } = await requireWorkspace(req.headers));
    }
```
(import `resolveMcpToken` depuis `@/lib/tenant`).

- [ ] **Step 4: Vérifier le passage + non-régression**

Run: `npx vitest run tests/dictations-routes.test.ts tests/events-bearer.test.ts tests/events.test.ts tests/comments-routes.test.ts tests/jobs-routes.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dictations "src/app/api/jobs/[id]/audio/route.ts" src/app/api/events/route.ts tests/dictations-routes.test.ts tests/events-bearer.test.ts
git commit -m "feat: routes dictées (dépôt, liste, retry, consume, delete), audio worker et SSE en Bearer"
```

---

### Task 4: Worker unique `scripts/worker.mjs` + `scripts/transcribe-worker.py` + README

**Files:**
- Rename: `scripts/extract-worker.mjs` → `scripts/worker.mjs` (`git mv`), contenu étendu
- Create: `scripts/transcribe-worker.py`
- Modify: `package.json` (script `"worker": "node scripts/worker.mjs"`)
- Modify: `README.md` (toutes les mentions de `extract-worker.mjs` → `worker.mjs` ; section worker)
- Modify: `src/components/idea-detail.tsx` (indice worker : `node scripts/worker.mjs`)
- Modify: `docs/specs/2026-08-31-sources-extraction-design.md` (mentions du nom du script)
- Modify: `.claude` memory non concernée (hors repo)

**Interfaces:**
- Consomme : `GET /api/jobs/:id/audio` (comment + dictation), `GET /api/events` en Bearer (Task 3), outils MCP existants.
- Produit : le consommateur des jobs `extract` et `transcribe`. Env : `CS_MCP_URL`, `CS_MCP_TOKEN`, `CS_WHISPER_MODEL`, `CS_WHISPER_LANG` (défaut `fr`), `CS_WHISPER_PROMPT`, `CS_PYTHON` (défaut `$HOME/.claude/tools/yt-transcript/venv/bin/python`), flag `--once`.

- [ ] **Step 1: Renommer et réécrire `scripts/worker.mjs`**

`git mv scripts/extract-worker.mjs scripts/worker.mjs`, puis remplacer le contenu par (le code des extracteurs `assertPublicHttpUrl`, `extractUrl`, `extractVideo` est repris TEL QUEL depuis le fichier existant — ne pas les retaper de mémoire, les conserver) :

```js
#!/usr/bin/env node
// scripts/worker.mjs — LE worker local de content-studio.
//
// Tourne sur le Mac (là où vivent yt-dlp, ffmpeg et mlx-whisper) et parle
// EXCLUSIVEMENT MCP à content-studio, comme n'importe quel worker — jamais
// la base en direct.
//
//   CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… \
//     node scripts/worker.mjs [--once]
//
// kinds pris en charge :
//   extract     (cible source)  url → fetch + Readability ; video → yt-dlp + mlx_whisper CLI
//   transcribe  (cible comment OU dictation) audio → ffmpeg → mlx-whisper RÉSIDENT → complete_job({ text })
//
// Temps réel : le worker s'abonne à /api/events (Bearer) et traite un job
// queued dès son apparition ; le poll toutes les 15 s reste le filet.
// Tout échec → fail_job(message lisible) ; la cible passe failed côté outil.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.CS_MCP_URL;
const MCP_TOKEN = process.env.CS_MCP_TOKEN;
const WHISPER_MODEL = process.env.CS_WHISPER_MODEL ?? "mlx-community/whisper-large-v3-turbo";
const PYTHON = process.env.CS_PYTHON ?? `${process.env.HOME}/.claude/tools/yt-transcript/venv/bin/python`;
const ONCE = process.argv.includes("--once");
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000; // le serveur bascule un running en failed après 10 min de silence
const MODEL_IDLE_MS = 15 * 60_000; // modèle déchargé après 15 min sans dictée (~0,9 Go de RAM)
const KINDS = new Set(["extract", "transcribe"]);
const WORKER_LABEL = `worker@${hostname()}`;

if (!MCP_URL || !MCP_TOKEN) {
  console.error("CS_MCP_URL et CS_MCP_TOKEN requis (token workspace : UI → Réglages → Tokens MCP)");
  process.exit(1);
}
const BASE = MCP_URL.replace(/\/api\/mcp\/?$/, "");
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

let client;
async function connect() {
  client = new Client({ name: "content-studio-worker", version: "2.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
}

// Appel d'outil + décodage du JSON métier. Une erreur métier ({ error }) est
// convertie en exception : chaque appelant décide (claim perdu = on passe).
// Piège : claim_job/complete_job/fail_job rendent la LIGNE du job, qui porte
// sa propre colonne `error` (null, ou le message d'un échec passé) — seule
// une réponse SANS `id` est une erreur métier, jamais une ligne rendue.
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const data = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (data && typeof data === "object" && !Array.isArray(data)
    && "error" in data && !("id" in data)) {
    throw new Error(`${name}: ${data.error}`);
  }
  return data;
}

// ---- extracteurs (kind extract) — INCHANGÉS, repris de extract-worker.mjs ----
// [coller ici, tels quels : assertPublicHttpUrl, extractUrl, extractVideo]

// ---- transcripteur résident (kind transcribe) ------------------------------
// Le modèle pèse ~0,9 Go : il démarre à la première dictée, reste chargé
// tant que ça dicte, et s'efface après MODEL_IDLE_MS sans travail.
let py = null, pyReady = false, waiting = [], idleTimer = null, stopping = false;

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (py && !waiting.length) { log("modèle déchargé (inactivité)"); stopping = true; py.stdin.end(); }
  }, MODEL_IDLE_MS);
}

function ensurePython() {
  if (py) return;
  stopping = false;
  log("chargement du modèle mlx-whisper…");
  py = spawn(PYTHON, [join(HERE, "transcribe-worker.py")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CS_WHISPER_MODEL: WHISPER_MODEL },
  });
  let buf = "";
  py.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { pyReady = true; log("modèle chargé — prêt à transcrire"); continue; }
      const resolve = waiting.shift();
      if (resolve) resolve(msg);
      if (!waiting.length) armIdle();
    }
  });
  py.on("error", (e) => {
    // ENOENT = python du venv introuvable : les dictées en attente échouent proprement
    const message = e?.code === "ENOENT" ? `python introuvable : ${PYTHON} (CS_PYTHON)` : e.message;
    waiting.forEach((r) => r({ error: message })); waiting = [];
  });
  py.on("exit", (code) => {
    const expected = stopping;
    py = null; pyReady = false;
    waiting.forEach((r) => r({ error: "transcripteur arrêté" })); waiting = [];
    if (!expected) log(`transcripteur arrêté (code ${code}) — il repartira à la prochaine dictée`);
  });
}

function transcribeWav(wav) {
  ensurePython();
  clearTimeout(idleTimer);
  return new Promise((resolve) => { waiting.push(resolve); py.stdin.write(wav + "\n"); });
}

async function transcribeJob(job) {
  const res = await fetch(`${BASE}/api/jobs/${job.id}/audio`, {
    headers: { Authorization: `Bearer ${MCP_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`audio introuvable (${res.status})`);
  const dir = await mkdtemp(join(tmpdir(), "cs-dictee-"));
  try {
    const src = join(dir, "in.bin");
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
    const wav = join(dir, "audio.wav");
    try {
      await run("ffmpeg", ["-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-y", wav]);
    } catch (e) {
      if (e?.code === "ENOENT") throw new Error("binaire manquant : ffmpeg (PATH du worker)");
      throw new Error(`ffmpeg : ${String(e.message).split("\n")[0]}`);
    }
    const out = await transcribeWav(wav);
    if (out.error) throw new Error(out.error);
    return { text: out.text, sec: out.sec };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- boucle ---------------------------------------------------------------

async function processJob(job) {
  try {
    await call("claim_job", { job_id: job.id, worker_label: WORKER_LABEL });
  } catch (e) {
    log(`claim perdu ${job.id} (${e.message})`);
    return;
  }
  const heartbeat = setInterval(() => {
    call("heartbeat_job", { job_id: job.id }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    if (job.kind === "extract") {
      const { source_kind, ref } = job.payload ?? {};
      if (typeof ref !== "string" || !ref) throw new Error("payload.ref manquant");
      log(`extract ${source_kind} ${ref}`);
      const { text, meta } = await (source_kind === "video" ? extractVideo(ref) : extractUrl(ref));
      await call("attach_extraction", { source_id: job.targetId, extracted_text: text, extracted_meta: meta });
      await call("complete_job", { job_id: job.id });
      log(`done ${job.id} (${text.length} caractères)`);
    } else if (job.kind === "transcribe") {
      log(`transcribe ${job.targetType} ${job.targetId}`);
      const { text, sec } = await transcribeJob(job);
      await call("complete_job", { job_id: job.id, result: { text } });
      log(`done ${job.id} (${sec}s) : ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    }
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`échec ${job.id} : ${message}`);
    await call("fail_job", { job_id: job.id, error: message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick() {
  const jobs = await call("list_jobs", { status: "queued" });
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!KINDS.has(job.kind)) continue;
    if (job.kind === "extract" && job.targetType !== "source") continue;
    if (job.kind === "transcribe" && job.targetType !== "comment" && job.targetType !== "dictation") continue;
    await processJob(job);
  }
}

// Réveil : un tour de boucle dès qu'un job queued apparaît (SSE), sans attendre le poll.
let wake = () => {};
const sleepOrWake = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wake = () => { clearTimeout(t); resolve(); };
});

async function watchEvents() {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { Authorization: `Bearer ${MCP_TOKEN}`, accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      log("abonné aux événements du workspace");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          try {
            const e = JSON.parse(data);
            if (e.type === "job.updated" && e.status === "queued" && KINDS.has(e.kind)) wake();
          } catch { /* trame illisible */ }
        }
      }
      throw new Error("flux fermé");
    } catch (e) {
      log(`événements : ${e.message} — reconnexion dans 3 s`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await connect();
log(`${WORKER_LABEL} branché sur ${MCP_URL}${ONCE ? " (--once)" : ""}`);
if (!ONCE) watchEvents();
do {
  try {
    await tick();
  } catch (e) {
    console.error(`boucle : ${e instanceof Error ? e.message : e}`);
    // session MCP expirée ou serveur redémarré : on se rebranche
    try { await connect(); } catch { /* retentera au prochain tour */ }
  }
  if (!ONCE) await sleepOrWake(POLL_MS);
} while (!ONCE);
if (py) { stopping = true; py.stdin.end(); }
process.exit(0);
```

- [ ] **Step 2: `scripts/transcribe-worker.py`**

```python
"""Transcripteur résident : charge mlx-whisper UNE fois, puis transcrit à la
demande. Un chemin .wav par ligne sur stdin → une ligne JSON sur stdout.

Piloté par scripts/worker.mjs. Le modèle reste en mémoire GPU : une dictée de
30 s revient en ~2 s au lieu de ~20 s si on relançait le processus à chaque
fois. Repris de formation-vdl-review/transcribe-worker.py.
"""
import json
import os
import sys
import time

import mlx_whisper

MODEL = os.environ.get("CS_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
LANG = os.environ.get("CS_WHISPER_LANG", "fr")
# Amorçage : sans vocabulaire, « Claude Code » devient « Cloud code » et
# « netlinking » « net linking ». Surchargeable par CS_WHISPER_PROMPT.
PROMPT = os.environ.get(
    "CS_WHISPER_PROMPT",
    "Dictée pour un studio de contenu sur l'IA, le SEO et le no-code. "
    "Vocabulaire : Claude, Claude Code, ChatGPT, GPT, OpenAI, Anthropic, MCP, agent, "
    "prompt, LLM, RAG, workflow, n8n, Make, Zapier, Supabase, Next.js, Vercel, WordPress, "
    "SEO, backlink, netlinking, Search Console, La Minute IA, LinkQuiver, GetLinkFast, "
    "newsletter, YouTube, tuto, communauté.",
)


def warm():
    """Premier appel = téléchargement/compilation : au démarrage, pas à la première dictée."""
    import numpy as np
    mlx_whisper.transcribe(
        np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL, language=LANG, verbose=False
    )


def hallucine(texte):
    """Whisper boucle parfois sur les silences : un segment long et très répétitif est écarté."""
    mots = texte.split()
    return len(mots) > 20 and len(set(mots)) / len(mots) < 0.25


warm()
print(json.dumps({"ready": True}), flush=True)

for ligne in sys.stdin:
    chemin = ligne.strip()
    if not chemin:
        continue
    t0 = time.time()
    try:
        res = mlx_whisper.transcribe(
            chemin,
            path_or_hf_repo=MODEL,
            language=LANG,
            initial_prompt=PROMPT,
            condition_on_previous_text=False,
            verbose=False,
        )
        morceaux = [
            s["text"].strip()
            for s in res["segments"]
            if s["text"].strip() and not hallucine(s["text"].strip())
        ]
        print(json.dumps({"text": " ".join(morceaux), "sec": round(time.time() - t0, 1)}), flush=True)
    except Exception as e:  # noqa: BLE001 — l'erreur remonte au worker, qui fail_job
        print(json.dumps({"error": str(e)[:300]}), flush=True)
```

- [ ] **Step 3: package.json, README, références au nom**

`package.json` scripts : ajouter `"worker": "node scripts/worker.mjs",` après `"test"`.

`README.md` : remplacer chaque `extract-worker.mjs` par `worker.mjs` ; dans la table des kinds, remplacer la ligne `transcribe` par :

```markdown
| `transcribe` | jamais par un bouton — créé par la route de dictée des commentaires (legacy) et par `POST /api/dictations` (dictée d'un champ) | worker `GET /api/jobs/:id/audio` → ffmpeg → mlx-whisper → `complete_job({ text })` ; l'outil pose le texte sur le commentaire ou la dictée |
```
et renommer la section « Extraction des sources : le worker fourni » en « Le worker fourni : extraction ET dictée », avec le paragraphe :

```markdown
Un seul process sur le Mac consomme les jobs `extract` (articles → Readability,
vidéos YouTube → yt-dlp + mlx-whisper) et `transcribe` (dictées et commentaires
vocaux → ffmpeg + mlx-whisper résident, ≈ 2 s par dictée) :

​```sh
CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… npm run worker   # ou node scripts/worker.mjs [--once]
​```

Il s'abonne à `/api/events` avec son token pour traiter un job dès qu'il est posé
(le poll de 15 s reste le filet). Réglages par env : `CS_WHISPER_MODEL`,
`CS_WHISPER_LANG` (fr), `CS_WHISPER_PROMPT` (vocabulaire d'amorçage), `CS_PYTHON`
(défaut : le venv `~/.claude/tools/yt-transcript`). Prérequis : `ffmpeg`, `yt-dlp`,
mlx-whisper dans ce venv (Apple Silicon), `npm install` AVEC les devDependencies.
```
(retirer les zero-width spaces devant les fences en copiant.)

`src/components/idea-detail.tsx` : `node scripts/extract-worker.mjs` → `node scripts/worker.mjs`. `docs/specs/2026-08-31-sources-extraction-design.md` : idem (les 3 mentions).

- [ ] **Step 4: Vérifications**

Run: `node --check scripts/worker.mjs` → aucune sortie. `~/.claude/tools/yt-transcript/venv/bin/python -m py_compile scripts/transcribe-worker.py` → aucune sortie. `node scripts/worker.mjs` sans env → message requis, exit 1. `grep -rn "extract-worker" README.md src docs/specs` → aucune occurrence.

- [ ] **Step 5: Smoke réel (si un serveur dev + token sont disponibles ; sinon le noter dans le rapport)**

Lancer `CS_MCP_URL=http://127.0.0.1:3004/api/mcp CS_MCP_TOKEN=<token> node scripts/worker.mjs`, puis déposer une dictée par `curl -X POST -H "content-type: audio/wav" --data-binary @<un wav court> "http://127.0.0.1:3004/api/dictations?field_key=test"` avec un cookie de session (ou par la lib via un test) — attendu : log `transcribe dictation …` puis `done … : <texte>`.

- [ ] **Step 6: Commit**

```bash
git add scripts/worker.mjs scripts/transcribe-worker.py package.json README.md src/components/idea-detail.tsx docs/specs/2026-08-31-sources-extraction-design.md
git commit -m "feat: worker unique (extract + transcribe), transcripteur résident mlx-whisper, réveil par SSE"
```
(`git mv` a déjà indexé le renommage ; `git add scripts/worker.mjs` suffit à prendre le contenu.)

---

### Task 5: Cœur client — `use-recorder` déplacé, `insert-text`, `use-dictation`, `DictateButton`

**Files:**
- Move: `src/components/review/use-recorder.ts` → `src/hooks/use-recorder.ts` (`git mv`, contenu inchangé) ; mettre à jour l'import dans `src/components/review/comment-popover.tsx` (temporaire, réécrit en Task 6)
- Create: `src/lib/insert-text.ts`
- Create: `src/lib/merge-refs.ts`
- Create: `src/hooks/use-dictation.ts`
- Create: `src/components/dictate-button.tsx`
- Test: `tests/insert-text.test.ts`

**Interfaces:**
- Consomme : routes de Task 3 (`POST /api/dictations`, `GET /api/dictations?field_key&open=1`, `GET /api/dictations/[id]`, `POST …/consume`), événement `dictation.updated`, `useWorkspaceEvents`.
- Produit : `computeInsertion(value, selStart, selEnd, text, { singleLine? }) → { value, caret }` ; `insertAtCursor(el, text)` ; `mergeRefs(...refs)` ; `useDictation({ fieldKey, onText, recover? }) → { supported, recording, pending, error, toggle }` ; `<DictateButton fieldKey onText recover? className? />` (rend `null` si le micro n'est pas supporté).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/insert-text.test.ts
import { describe, it, expect } from "vitest";
import { computeInsertion } from "@/lib/insert-text";

describe("computeInsertion — insertion au curseur", () => {
  it("insère au curseur avec une espace de séparation quand il faut", () => {
    expect(computeInsertion("Bonjour", 7, 7, "tout le monde")).toEqual({ value: "Bonjour tout le monde", caret: 21 });
    expect(computeInsertion("Bonjour ", 8, 8, "tout")).toEqual({ value: "Bonjour tout", caret: 12 });
    expect(computeInsertion("", 0, 0, "Salut")).toEqual({ value: "Salut", caret: 5 });
  });

  it("remplace une sélection et ajoute une espace après si le texte suivant colle", () => {
    expect(computeInsertion("un XXX trois", 3, 6, "deux")).toEqual({ value: "un deux trois", caret: 7 });
    expect(computeInsertion("ab", 1, 1, "X")).toEqual({ value: "a X b", caret: 4 });
  });

  it("singleLine : retours à la ligne → espaces ; texte vide → inchangé ; curseur hors bornes → borné", () => {
    expect(computeInsertion("", 0, 0, "ligne 1\nligne 2\n", { singleLine: true })).toEqual({ value: "ligne 1 ligne 2", caret: 15 });
    expect(computeInsertion("abc", 1, 1, "   ")).toEqual({ value: "abc", caret: 1 });
    expect(computeInsertion("abc", 99, 99, "d")).toEqual({ value: "abc d", caret: 5 });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/insert-text.test.ts`
Attendu : FAIL — module `@/lib/insert-text` introuvable.

- [ ] **Step 3: Implémenter**

`src/lib/insert-text.ts` :

```ts
// Insertion d'un texte dicté au curseur d'un champ, SANS connaître l'état
// React qui le contrôle : la partie pure (testée) calcule la nouvelle valeur,
// la glue DOM pose la valeur par le setter natif puis dispatch `input` —
// React déclenche `onChange` comme pour une frappe.

export function computeInsertion(
  value: string, selStart: number, selEnd: number, text: string,
  opts: { singleLine?: boolean } = {},
): { value: string; caret: number } {
  let t = opts.singleLine ? text.replace(/\s*\n+\s*/g, " ") : text;
  t = t.trim();
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  if (!t) return { value, caret: start };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + t + trail;
  return { value: before + inserted + after, caret: start + inserted.length };
}

export function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const single = el instanceof HTMLInputElement;
  const { value, caret } = computeInsertion(
    el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, text, { singleLine: single },
  );
  const proto = single ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch { /* type non sélectionnable */ }
}
```

`src/lib/merge-refs.ts` :

```ts
import type { Ref, RefCallback } from "react";

/** Un seul ref pour deux consommateurs (le nôtre + celui de l'appelant). */
export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (value) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(value);
      else (ref as { current: T | null }).current = value;
    }
  };
}
```

`src/hooks/use-dictation.ts` :

```ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "@/hooks/use-recorder";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type DictationRow = {
  id: string; status: "pending" | "done" | "failed"; text: string;
  fieldKey: string; consumedAt: string | null; error: string | null;
};

/**
 * Dictée asynchrone d'un champ : enregistre, poste l'audio, puis livre le
 * texte à `onText` quand le worker a fini (SSE) — même si l'utilisateur a
 * continué à travailler entre-temps. `recover` = au montage, reprendre ce que
 * ce fieldKey attendait (reload pendant une transcription).
 */
export function useDictation({ fieldKey, onText, recover = true }: {
  fieldKey: string; onText: (text: string) => void; recover?: boolean;
}) {
  const { supported, recording, start, stop } = useRecorder();
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const delivered = useRef(new Set<string>());

  const deliver = useCallback(async (d: DictationRow) => {
    if (delivered.current.has(d.id)) return; // un seul dépôt par dictée, quel que soit le nombre d'événements
    delivered.current.add(d.id);
    onTextRef.current(d.text);
    setPendingIds((ids) => ids.filter((x) => x !== d.id));
    await fetch(`/api/dictations/${d.id}/consume`, { method: "POST" }).catch(() => { /* le tiroir la montrera « prête » */ });
  }, []);

  const send = useCallback(async (blob: Blob, mime: string) => {
    const res = await fetch(`/api/dictations?field_key=${encodeURIComponent(fieldKey)}`, {
      method: "POST", headers: { "content-type": mime }, body: blob,
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Envoi de la dictée impossible.");
      return;
    }
    const { id } = await res.json();
    setPendingIds((ids) => [...ids, id]);
  }, [fieldKey]);

  // Reprise au montage : ce que le champ attendait encore.
  useEffect(() => {
    if (!recover) return;
    let alive = true;
    fetch(`/api/dictations?field_key=${encodeURIComponent(fieldKey)}&open=1`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: DictationRow[]) => {
        if (!alive) return;
        for (const d of rows) {
          if (d.status === "done" && !d.consumedAt) deliver(d);
          else if (d.status === "pending") setPendingIds((ids) => (ids.includes(d.id) ? ids : [...ids, d.id]));
        }
      })
      .catch(() => { /* reprise impossible : le tiroir reste la source de vérité */ });
    return () => { alive = false; };
  }, [fieldKey, recover, deliver]);

  useWorkspaceEvents((e) => {
    if (e.type !== "dictation.updated" || e.fieldKey !== fieldKey) return;
    if (e.status === "done") {
      fetch(`/api/dictations/${e.dictationId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: DictationRow | null) => { if (d && !d.consumedAt) deliver(d); })
        .catch(() => {});
    } else if (e.status === "failed") {
      setPendingIds((ids) => ids.filter((x) => x !== e.dictationId));
      setError("Transcription échouée — voir la page Dictées.");
    } else if (e.status === "deleted") {
      setPendingIds((ids) => ids.filter((x) => x !== e.dictationId));
    }
  });

  // Plafond des 3 min : le recorder s'arrête seul — venir chercher le blob,
  // sinon la dictée est perdue en silence (même mécanique que l'ancien popover).
  const wasRecording = useRef(false);
  useEffect(() => {
    const was = wasRecording.current;
    wasRecording.current = recording;
    if (!was || recording) return;
    stop().then((r) => { if (r) send(r.blob, r.mime); }).catch(() => {});
  }, [recording, stop, send]);

  const toggle = useCallback(async () => {
    setError(null);
    if (recording) {
      const r = await stop();
      if (r) await send(r.blob, r.mime);
    } else {
      try { await start(); } catch { setError("Micro refusé par le navigateur."); }
    }
  }, [recording, start, stop, send]);

  return { supported, recording, pending: pendingIds.length, error, toggle };
}
```

`src/components/dictate-button.tsx` :

```tsx
"use client";
import { Loader2, Mic, Square } from "lucide-react";
import { useDictation } from "@/hooks/use-dictation";
import { cn } from "@/lib/utils";

/**
 * Le micro d'un champ : idle → enregistre, enregistrement → termine et envoie,
 * en attente → compteur. Absent si le navigateur n'a pas de micro (pas de
 * bouton mort).
 */
export function DictateButton({ fieldKey, onText, recover, className }: {
  fieldKey: string; onText: (text: string) => void; recover?: boolean; className?: string;
}) {
  const { supported, recording, pending, error, toggle } = useDictation({ fieldKey, onText, recover });
  if (!supported) return null;
  const label = recording ? "Terminer la dictée" : pending ? `${pending} transcription(s) en cours` : "Dicter";
  return (
    <button
      type="button"
      onClick={toggle}
      title={error ?? label}
      aria-label={label}
      aria-pressed={recording}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-muted transition-colors duration-150 hover:bg-raised hover:text-ink",
        recording && "text-danger animate-pulse",
        error && "text-danger",
        className,
      )}
    >
      {recording ? (
        <Square className="size-3.5" aria-hidden />
      ) : pending ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span className="text-[10px] tabular-nums">{pending}</span>
        </>
      ) : (
        <Mic className="size-4" aria-hidden />
      )}
    </button>
  );
}
```

Déplacement : `git mv src/components/review/use-recorder.ts src/hooks/use-recorder.ts` puis dans `comment-popover.tsx` remplacer l'import par `import { useRecorder } from "@/hooks/use-recorder";` (Task 6 supprime cet import).

- [ ] **Step 4: Vérifier**

Run: `npx vitest run tests/insert-text.test.ts` → PASS ; `npx tsc --noEmit` → 0 erreur.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-recorder.ts src/components/review/comment-popover.tsx src/lib/insert-text.ts src/lib/merge-refs.ts src/hooks/use-dictation.ts src/components/dictate-button.tsx tests/insert-text.test.ts
git commit -m "feat: cœur client de la dictée — insertion au curseur, hook use-dictation, bouton micro"
```

---

### Task 6: Micro dans les primitives `Input`/`Textarea`, chat et popover de commentaire

**Files:**
- Modify: `src/components/ui/textarea.tsx`, `src/components/ui/input.tsx`
- Modify: `src/components/cockpit/chat-drawer.tsx` (le `<textarea>` brut → `Textarea`)
- Modify: `src/components/review/comment-popover.tsx` (plus de dictée maison), `src/components/review/review-pane.tsx` (plus de `onSaveVoice`)
- Modify: `src/components/idea-detail.tsx`, `src/components/workspace/item-list.tsx` (clés explicites)
- Modify: `src/app/(auth)/register/page.tsx` (`dictation={false}` sur le champ nom)

**Interfaces:**
- Consomme : `DictateButton`, `insertAtCursor`, `mergeRefs` (Task 5).
- Produit : prop `dictation?: false | { fieldKey?: string }` sur `Input` et `Textarea` ; type exporté `DictationProp`.

- [ ] **Step 1: `src/components/ui/textarea.tsx`**

```tsx
"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DictateButton } from "@/components/dictate-button";
import { insertAtCursor } from "@/lib/insert-text";
import { mergeRefs } from "@/lib/merge-refs";

export type DictationProp = false | { fieldKey?: string };

/** Clé de champ par défaut : stable pour une page et un champ donnés (reprise après reload). */
export function defaultFieldKey(pathname: string, props: { name?: string; id?: string; placeholder?: string }, fallback: string) {
  return `${pathname}#${props.name ?? props.id ?? props.placeholder ?? fallback}`;
}

function Textarea({ className, dictation, ref, ...props }: React.ComponentProps<"textarea"> & { dictation?: DictationProp }) {
  const inner = React.useRef<HTMLTextAreaElement>(null);
  const pathname = usePathname();
  const enabled = dictation !== false && !props.readOnly && !props.disabled;
  const fieldKey = (dictation && dictation.fieldKey) || defaultFieldKey(pathname, props, "textarea");
  const el = (
    <textarea
      ref={mergeRefs(inner, ref)}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        enabled && "pr-9",
        className
      )}
      {...props}
    />
  );
  if (!enabled) return el;
  return (
    <div className="relative w-full min-w-0">
      {el}
      <DictateButton
        fieldKey={fieldKey}
        recover={!!(dictation && dictation.fieldKey)}
        onText={(t) => { if (inner.current) insertAtCursor(inner.current, t); }}
        className="absolute top-1.5 right-1.5"
      />
    </div>
  );
}

export { Textarea }
```

- [ ] **Step 2: `src/components/ui/input.tsx`**

```tsx
"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";
import { DictateButton } from "@/components/dictate-button";
import { insertAtCursor } from "@/lib/insert-text";
import { mergeRefs } from "@/lib/merge-refs";
import { defaultFieldKey, type DictationProp } from "@/components/ui/textarea";

// Dicter une adresse, un mot de passe ou une URL n'a pas de sens : ces types
// n'ont jamais de micro, quoi que dise la prop.
const NO_DICTATION_TYPES = new Set(["email", "password", "url", "number", "search", "date", "time", "datetime-local", "file", "checkbox", "radio", "hidden", "color", "range"]);

function Input({ className, type, dictation, ref, ...props }: React.ComponentProps<"input"> & { dictation?: DictationProp }) {
  const inner = React.useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const enabled = dictation !== false && !NO_DICTATION_TYPES.has(type ?? "text") && !props.readOnly && !props.disabled;
  const fieldKey = (dictation && dictation.fieldKey) || defaultFieldKey(pathname, props, "input");
  const el = (
    <InputPrimitive
      ref={mergeRefs(inner, ref)}
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        enabled && "pr-8",
        className
      )}
      {...props}
    />
  );
  if (!enabled) return el;
  return (
    <div className="relative w-full min-w-0">
      {el}
      <DictateButton
        fieldKey={fieldKey}
        recover={!!(dictation && dictation.fieldKey)}
        onText={(t) => { if (inner.current) insertAtCursor(inner.current, t); }}
        className="absolute top-0.5 right-0.5"
      />
    </div>
  );
}

export { Input }
```

- [ ] **Step 3: Chat, popover, clés explicites, register**

`src/components/cockpit/chat-drawer.tsx` : importer `Textarea` depuis `@/components/ui/textarea` et remplacer `<textarea ref={textareaRef} … className="min-h-16 w-full flex-1 resize-none rounded-lg border border-line bg-raised px-2.5 py-2 text-sm text-ink outline-none placeholder:text-faint focus-visible:border-accent disabled:opacity-60" />` par le même élément en `<Textarea … dictation={{ fieldKey: \`chat:${activeLaneId}\` }} className="min-h-16 resize-none border-line bg-raised text-sm text-ink placeholder:text-faint focus-visible:border-accent disabled:opacity-60" />` (mêmes `ref`, `value`, `disabled`, `placeholder`, `onChange`, `onClick`, `onKeyDown`, `rows`). Le texte dicté déclenche `onChange` (donc `onDraftChange`) comme une frappe.

`src/components/review/comment-popover.tsx` : supprimer l'import `useRecorder`, la prop `onSaveVoice` (type et destructuration), le `useRecorder()`, l'effet `wasRecording`, la fonction `dicter` et le bouton « Dicter » ; la `Textarea` devient
```tsx
      <Textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)}
        dictation={{ fieldKey: existing ? `comment:${existing.id}` : "comment:new" }}
        placeholder={existing ? "Modifier la remarque…" : "Ta remarque (Cmd+Entrée pour enregistrer, ou dicte-la)"} />
```
Garder les deux `<p>` sur `existing?.transcription` (commentaires vocaux legacy encore affichés). Mettre à jour le commentaire de tête : « texte libre, dictée par le micro standard de la Textarea ».

`src/components/review/review-pane.tsx` : supprimer le bloc `onSaveVoice={async (blob, mime) => { … }}` et retirer `createVoice` de la destructuration de `useComments(...)` (chercher `createVoice` dans le fichier ; s'il n'est plus utilisé, l'enlever de la ligne `const { … } = useComments(`).

`src/components/idea-detail.tsx` : `<Textarea placeholder="…ou colle un texte" …>` gagne `dictation={{ fieldKey: \`source:new:${ideaId}\` }}` ; `<Input placeholder="https://…" …>` gagne `dictation={false}` (une URL ne se dicte pas).

`src/components/workspace/item-list.tsx` (formulaire de nouvelle idée) : `<Input autoFocus placeholder="Titre" …>` gagne `dictation={{ fieldKey: "idea:new:title" }}` et `<Textarea placeholder="Notes, angle, sources…" …>` gagne `dictation={{ fieldKey: "idea:new:notes" }}`.

`src/app/(auth)/register/page.tsx` : `<Input type="text" placeholder="nom" …>` gagne `dictation={false}`.

- [ ] **Step 4: Vérifier**

Run: `npx tsc --noEmit` → 0 erreur ; `npx vitest run` → suite verte (`chat-drawer.test.ts` et `comments-routes.test.ts` compris).
Contrôle visuel (`npm run dev` sur un port libre) : un micro apparaît à droite de chaque champ texte et zone de texte (fiche idée, nouvelle idée, réglages, chat, popover de commentaire), pas sur login/register ni sur le champ URL.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/textarea.tsx src/components/ui/input.tsx src/components/cockpit/chat-drawer.tsx src/components/review/comment-popover.tsx src/components/review/review-pane.tsx src/components/idea-detail.tsx src/components/workspace/item-list.tsx "src/app/(auth)/register/page.tsx"
git commit -m "feat: micro de dictée intégré aux primitives Input/Textarea, chat et commentaires"
```

---

### Task 7: Micro dans l'éditeur tiptap (`editor.tsx`)

**Files:**
- Modify: `src/components/editor.tsx` (bloc de rendu, lignes `return (<div className="space-y-1.5"> …`)

**Interfaces:**
- Consomme : `DictateButton` (Task 5) ; l'instance `editor` du composant ; `contentId` (prop existante).
- Produit : rien de nouveau.

- [ ] **Step 1: Implémenter**

Importer `import { DictateButton } from "@/components/dictate-button";` et remplacer

```tsx
      <div className="min-h-[400px] rounded-xl border border-line bg-surface p-6 transition-colors duration-150 focus-within:border-line-strong">
        <EditorContent editor={editor} />
      </div>
```
par
```tsx
      <div className="relative min-h-[400px] rounded-xl border border-line bg-surface p-6 transition-colors duration-150 focus-within:border-line-strong">
        <EditorContent editor={editor} />
        {/* Dictée au curseur : insertContent passe par onUpdate, donc par l'autosave. */}
        <DictateButton
          fieldKey={`content:${contentId}:body`}
          recover
          onText={(t) => { editor?.chain().focus().insertContent(t).run(); }}
          className="absolute top-3 right-3"
        />
      </div>
```

- [ ] **Step 2: Vérifier**

Run: `npx tsc --noEmit` → 0 erreur ; `npx vitest run tests/contents-revisions.test.ts tests/e2e-cockpit.test.ts` → PASS. Contrôle visuel : ouvrir un contenu, dicter, le texte s'insère au curseur et « Enregistrement… » apparaît.

- [ ] **Step 3: Commit**

```bash
git add src/components/editor.tsx
git commit -m "feat: dictée au curseur dans l'éditeur de contenu"
```

---

### Task 8: Page « Dictées » + entrée de barre latérale avec badge

**Files:**
- Create: `src/app/(app)/dictations/page.tsx`
- Modify: `src/components/workspace/sidebar.tsx` (entrée + badge)
- Modify: `src/components/cockpit/status-badge.tsx:60` (union `kind` gagne `"dictation"`)

**Interfaces:**
- Consomme : `GET /api/dictations?limit=50`, `POST …/retry`, `DELETE …`, événement `dictation.updated`, `StatusBadge`, `useWorkspaceEvents`.
- Produit : la page `/dictations`.

- [ ] **Step 1: `src/app/(app)/dictations/page.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type Dictation = {
  id: string; status: "pending" | "done" | "failed"; text: string; error: string | null;
  fieldKey: string; consumedAt: string | null; createdAt: string;
};

/** Le tiroir : tout ce qui a été dicté, en attente / prêt / en échec — rien ne se perd. */
export default function DictationsPage() {
  const [rows, setRows] = useState<Dictation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/dictations?limit=50");
    if (res.ok) setRows(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);
  useWorkspaceEvents((e) => { if (e.type === "dictation.updated") load(); });

  async function act(id: string, action: "retry" | "delete") {
    setError(null);
    const res = action === "retry"
      ? await fetch(`/api/dictations/${id}/retry`, { method: "POST" })
      : await fetch(`/api/dictations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Action impossible.");
    }
    load();
  }

  async function copy(d: Dictation) {
    try { await navigator.clipboard.writeText(d.text); setCopied(d.id); setTimeout(() => setCopied(null), 1500); }
    catch { setError("Presse-papiers indisponible."); }
  }

  const pending = rows.filter((d) => d.status === "pending").length;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Dictées</h1>
        <span className="text-[11px] text-faint tabular-nums">{pending} en cours</span>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <SectionCard title="Les 50 dernières">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Aucune dictée — le micro à droite de chaque champ envoie ici.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((d) => (
              <li key={d.id} className="rounded-lg border border-line bg-raised/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{d.fieldKey || "champ inconnu"}</span>
                  {d.consumedAt && <span className="text-[10px] tracking-widest text-faint uppercase">insérée</span>}
                  <StatusBadge kind="dictation" value={d.status} className={d.status === "pending" ? "animate-pulse" : undefined} />
                </div>
                {d.status === "done" && (
                  <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{d.text.length > 400 ? `${d.text.slice(0, 400)}…` : d.text}</p>
                )}
                {d.status === "failed" && <p className="mt-2 text-xs text-danger">{d.error ?? "transcription échouée"}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.status === "done" && (
                    <Button size="sm" variant="outline" onClick={() => copy(d)}>{copied === d.id ? "Copié" : "Copier"}</Button>
                  )}
                  {d.status === "failed" && <Button size="sm" variant="outline" onClick={() => act(d.id, "retry")}>Réessayer</Button>}
                  <Button size="sm" variant="outline" onClick={() => act(d.id, "delete")}>Supprimer</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <p className="text-xs text-faint">
        Le texte d&apos;une dictée s&apos;insère tout seul dans son champ s&apos;il est encore ouvert ; sinon il t&apos;attend ici.
      </p>
    </div>
  );
}
```

`src/components/cockpit/status-badge.tsx` : `kind: "idea" | "content" | "source" | "gauge" | "job" | "comment" | "dictation";`.

- [ ] **Step 2: Barre latérale**

Dans `src/components/workspace/sidebar.tsx` : à côté de `proposed`, un compteur `pendingDictations` chargé par `fetch("/api/dictations?status=pending&limit=200")` (longueur du tableau) au montage et sur `dictation.updated` :

```ts
  const [pendingDictations, setPendingDictations] = useState(0);
  const loadDictations = useCallback(() => {
    fetch("/api/dictations?status=pending&limit=200")
      .then((res) => (res.ok ? res.json() : null))
      .then((rows: unknown[] | null) => { if (rows) setPendingDictations(rows.length); })
      .catch(() => { /* badge discret */ });
  }, []);
  useEffect(() => { loadDictations(); }, [loadDictations]);
  useWorkspaceEvents((e) => {
    if (e.type === "watch.updated") loadProposed();
    if (e.type === "dictation.updated") loadDictations();
  });
```
(fusionner avec le `useWorkspaceEvents` existant : un seul appel avec les deux `if`.)

Après le `<nav>` des buckets, ajouter :

```tsx
          <nav className="grid gap-0.5 px-2 pt-1">
            <Link href="/dictations" onClick={() => setMobileOpen(false)}
              aria-current={pathname === "/dictations" ? "page" : undefined}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                pathname === "/dictations" ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
              Dictées
              {pendingDictations > 0 && (
                <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-medium text-accent tabular-nums">{pendingDictations}</span>
              )}
            </Link>
          </nav>
```

- [ ] **Step 3: Vérifier**

Run: `npx tsc --noEmit` → 0 erreur ; `npx vitest run` → suite verte. Contrôle visuel : `/dictations` liste les dictées, le badge de la barre latérale suit les `pending`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/dictations/page.tsx" src/components/workspace/sidebar.tsx src/components/cockpit/status-badge.tsx
git commit -m "feat: page Dictées (copier, réessayer, supprimer) et badge dans la barre latérale"
```

---

### Task 9: Vérification finale, base de dev migrée, smoke, spec

**Files:**
- Modify: `docs/specs/2026-09-04-dictation-design.md` (statut + déviations assumées)

- [ ] **Step 1: Suite complète + types**

Run: `npx vitest run` puis `npx tsc --noEmit` (timeout 120 s). Tout vert, sinon corriger AVANT de continuer.

- [ ] **Step 2: Migrer la base de dev**

Run: `DATABASE_URL=postgres://cs:cs@127.0.0.1:55434/content_studio npm run db:migrate` — attendu : migration 0008 appliquée (tables `dictations`, `dictation_audio` présentes : `psql "postgres://cs:cs@127.0.0.1:55434/content_studio" -c "\d dictations"`).

- [ ] **Step 3: Smoke de bout en bout (serveur dev + worker)**

1. Serveur dev sur un port libre (3003 si libre, sinon `npx next dev -H 127.0.0.1 -p 3004`).
2. `CS_MCP_URL=http://127.0.0.1:<port>/api/mcp CS_MCP_TOKEN=<token du workspace> npm run worker` dans un second terminal — attendu : « abonné aux événements du workspace ».
3. Dans l'UI : ouvrir une idée, cliquer le micro des notes, parler 5 s, terminer. Attendu : compteur « 1 » sur le micro, log worker `transcribe dictation …` puis `done … : <texte>` en ≈ 3 s (première fois : + chargement du modèle ≈ 20 s), texte inséré au curseur, page `/dictations` avec la dictée « insérée ».
4. Recharger la page pendant une transcription : le texte arrive quand même (reprise au montage) ou attend sur `/dictations`.
Si l'environnement ne le permet pas, noter précisément ce qui n'a pas pu être joué dans le rapport.

- [ ] **Step 4: Spec**

Dans `docs/specs/2026-09-04-dictation-design.md` : remplacer `**Statut** : validé (design), plan à venir` par `**Statut** : implémenté (plan docs/plans/2026-09-04-dictation.md)` ; ajouter en §5.4 la déviation « pas de micro sur l'éditeur de relecture (lecture seule) : les commentaires se dictent via la Textarea du popover », en §5.6 « le tiroir est une page `/dictations` + entrée de barre latérale avec badge », et en §3 « le paramètre de reprise s'appelle `open=1` (pending + done non consommée), pas `pending=1` ».

- [ ] **Step 5: Commit**

```bash
git add docs/specs/2026-09-04-dictation-design.md
git commit -m "docs: spec dictée partout — statut implémenté, déviations assumées"
```
