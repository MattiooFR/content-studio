# Vague « sources & extraction » — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre les sources d'une idée exploitables façon NotebookLM : dépôt d'articles (URL), de vidéos YouTube (transcript local mlx-whisper) et de textes longs, extraction par un worker externe via la file `agent_jobs`, affichage du texte extrait dans l'UI.

**Architecture:** L'outil ne fait qu'orchestrer (« l'outil n'exécute rien ») : `addSource` classe la source (url/video/text), pose un job `extract` ciblant la source ; un script worker dédié (`scripts/extract-worker.mjs`, sur le Mac) consomme les jobs par MCP (Readability pour les articles, yt-dlp + mlx-whisper pour YouTube) et rattache le texte via `attach_extraction`. Échec → source `failed` + bouton Réessayer. Événement `source.updated` sur le bus SSE existant.

**Tech Stack:** Next.js 16 (App Router), Drizzle + Postgres, mcp-handler (serveur MCP), `@modelcontextprotocol/sdk` **1.30.0** (client, déjà dans node_modules), vitest. Worker : Node ESM, `@mozilla/readability` + `linkedom` (nouvelles devDeps), binaires locaux `yt-dlp` et `mlx_whisper` (shims pyenv, présents sur le Mac).

**Spec:** `docs/specs/2026-08-31-sources-extraction-design.md`

## Global Constraints

- **Zéro migration SQL** : `sources.kind` et `agent_jobs.target_type` sont des colonnes `text` — les enums ne vivent que côté Drizzle (`src/lib/db/schema.ts`). Ne PAS lancer `db:generate`/`db:migrate`.
- Bornes exactes (spec §1.1) : `MAX_SOURCE_TEXT_LENGTH = 200_000`, `MAX_SOURCE_EXTRACTED_LENGTH = 1_500_000`. Bornes existantes inchangées (`MAX_SOURCE_REF_LENGTH = 2000`, `MAX_SOURCE_TITLE_LENGTH = 300`, `MAX_SOURCE_EXCERPT_LENGTH = 10000`).
- Tests : TOUJOURS `npx vitest run [fichier]` (jamais `npx vitest` nu — mode watch). La suite a besoin de la base de dev (voir `tests/setup.global.ts`) ; si un test échoue sur la connexion DB, démarrer la base avant de conclure.
- Typecheck : `npx tsc --noEmit` (pas de script `typecheck` dans ce repo), timeout 120 s.
- Git : commits par **pathspec explicite** (jamais `git add -A`). Chaque message de commit se termine par les deux lignes :
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Gw9ihHez1PCZq4B2THDKp1`
- Style : commentaires de code en français, même densité que l'existant (expliquer les contraintes non évidentes, pas le « quoi »). Copie UI en français.
- Messages d'erreur des libs : phrases françaises lisibles, mappées en 400/404/409 par les routes via `message.includes(...)` (pattern existant).
- Nouvelles dépendances npm limitées à `@mozilla/readability` (Mozilla) et `linkedom` (WebReflection) — légitimité vérifiée, en devDependencies.

---

### Task 1: Détection YouTube — `src/lib/youtube.ts`

**Files:**
- Create: `src/lib/youtube.ts`
- Test: `tests/youtube.test.ts`

**Interfaces:**
- Consomme : rien (module pur, aucun import — il DOIT rester importable depuis un composant client).
- Produit : `youtubeVideoId(ref: string): string | null` — l'id vidéo si `ref` est une URL YouTube reconnue, sinon `null`. Utilisé par Task 3 (sources), Task 6 (clip), Task 8 (UI).

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// tests/youtube.test.ts
import { describe, it, expect } from "vitest";
import { youtubeVideoId } from "@/lib/youtube";

describe("youtubeVideoId", () => {
  it("reconnaît watch / youtu.be / shorts / live / embed / hôtes mobiles", () => {
    expect(youtubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rend null pour tout le reste", () => {
    expect(youtubeVideoId("https://www.dwarkesh.com/p/openai-huggingface")).toBeNull();
    expect(youtubeVideoId("https://vimeo.com/123456")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/@unechaine")).toBeNull();
    expect(youtubeVideoId("https://www.youtube.com/watch")).toBeNull();
    expect(youtubeVideoId("javascript:alert(1)")).toBeNull();
    expect(youtubeVideoId("pas une url")).toBeNull();
    expect(youtubeVideoId("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/youtube.test.ts`
Attendu : FAIL — module `@/lib/youtube` introuvable.

- [ ] **Step 3: Implémenter**

```ts
// src/lib/youtube.ts
// Détection YouTube PURE (aucun import) : partagée entre la lib sources
// (reclassement url → video), la route /api/clip, et le composant client de
// la fiche idée (badge « vidéo ») — d'où un module sans dépendance serveur.
const ID = /^[A-Za-z0-9_-]{6,20}$/;

/** L'id vidéo si ref est une URL YouTube reconnue, sinon null. */
export function youtubeVideoId(ref: string): string | null {
  let u: URL;
  try { u = new URL(ref); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return ID.test(id) ? id : null;
  }
  if (host === "youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v") ?? "";
      return ID.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})(?:\/|$)/);
    return m ? m[1] : null;
  }
  return null;
}
```

- [ ] **Step 4: Vérifier le passage**

Run: `npx vitest run tests/youtube.test.ts`
Attendu : PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/youtube.ts tests/youtube.test.ts
git commit -m "feat: détection d'URL YouTube (lib pure partagée client/serveur)"
```

---

### Task 2: Jobs — cible `source`, garde `extract`, effets d'échec

**Files:**
- Modify: `src/lib/events.ts` (types `job.updated` + nouveau `source.updated`)
- Modify: `src/lib/db/schema.ts:247` (enum `targetType` de `agentJobs`)
- Modify: `src/lib/jobs.ts` (`JobTargetType`, `assertTarget`, `targetTitle`, garde dans `completeJob`, cas `extract` dans `applyFailureEffects`)
- Modify: `src/hooks/use-jobs.ts:15` (union du paramètre `targetType`)
- Test: `tests/jobs-extract.test.ts` (nouveau fichier)

**Interfaces:**
- Consomme : `addSource`/`attachExtraction`/`getSource`/`markSourceFailed` de `src/lib/sources.ts` (signatures ACTUELLES — cette task précède la refonte de Task 3 ; `addSource` avec `kind: "url", ref` fonctionne déjà).
- Produit : `createJob` accepte `targetType: "source"` ; `completeJob` refuse un job `extract` dont la source n'est pas `extracted` (message contenant « source non extraite ») ; `fail_job`/`cancel_job`/balayage silencieux d'un `extract` → `markSourceFailed(ws, targetId, message)`. Type d'événement `{ type: "source.updated"; sourceId: string; ideaId: string; status: string }` (publié en Task 4).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// tests/jobs-extract.test.ts
import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { addSource, attachExtraction, getSource } from "@/lib/sources";
import { createJob, claimJob, completeJob, failJob, cancelJob, listJobs } from "@/lib/jobs";

describe("jobs — cible source", () => {
  it("createJob accepte targetType source ; cloisonnement ; targetTitle = titre sinon ref", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await createIdea(a.workspaceId, { title: "Idée" });
    const sansTitre = await addSource(a.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/sans-titre",
    });
    const avecTitre = await addSource(a.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/avec-titre", title: "Un article",
    });

    await expect(
      createJob(b.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id })
    ).rejects.toThrow("cible introuvable dans ce workspace");

    await createJob(a.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id });
    await createJob(a.workspaceId, { kind: "probe", targetType: "source", targetId: avecTitre.id });
    const j1 = await listJobs(a.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id });
    const j2 = await listJobs(a.workspaceId, { kind: "probe", targetType: "source", targetId: avecTitre.id });
    expect(j1[0].targetTitle).toBe("https://exemple.fr/sans-titre");
    expect(j2[0].targetTitle).toBe("Un article");
  });

  it("completeJob d'un extract refuse tant que la source n'est pas extraite", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/article",
    });
    const { job } = await createJob(ws.workspaceId, {
      kind: "extract", targetType: "source", targetId: source.id,
      payload: { source_kind: "url", ref: source.ref },
    });
    await claimJob(ws.workspaceId, job.id, "test-worker");

    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/source non extraite/);

    await attachExtraction(ws.workspaceId, source.id, { extractedText: "texte extrait" });
    const done = await completeJob(ws.workspaceId, job.id, {});
    expect(done?.status).toBe("done");
  });

  it("fail_job / cancel_job d'un extract → la source passe failed avec la raison", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    const s1 = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://a.test/x" });
    const j1 = (await createJob(ws.workspaceId, { kind: "extract", targetType: "source", targetId: s1.id })).job;
    await claimJob(ws.workspaceId, j1.id, "test-worker");
    await failJob(ws.workspaceId, j1.id, "fetch impossible : 404");
    const f1 = await getSource(ws.workspaceId, s1.id);
    expect(f1?.status).toBe("failed");
    expect((f1?.extractedMeta as Record<string, unknown>).error).toBe("fetch impossible : 404");

    const s2 = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://a.test/y" });
    const j2 = (await createJob(ws.workspaceId, { kind: "extract", targetType: "source", targetId: s2.id })).job;
    await cancelJob(ws.workspaceId, j2.id);
    expect((await getSource(ws.workspaceId, s2.id))?.status).toBe("failed");
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/jobs-extract.test.ts`
Attendu : FAIL — `createJob` targetType `"source"` refusé par les types / « cible introuvable » sur le premier createJob légitime.

- [ ] **Step 3: Implémenter**

Dans `src/lib/events.ts`, remplacer la ligne `job.updated` et ajouter `source.updated` :

```ts
  // vague « cockpit agent » : chaque transition d'un job (création incluse)
  | { type: "job.updated"; jobId: string; kind: string; targetType: "idea" | "content" | "comment" | "source"; targetId: string; status: string }
  // vague « sources & extraction » : transitions d'une source (pending → extracted/failed, réessai)
  | { type: "source.updated"; sourceId: string; ideaId: string; status: string }
```

Dans `src/lib/db/schema.ts` (table `agentJobs`) :

```ts
  targetType: text("target_type", { enum: ["idea", "content", "comment", "source"] }).notNull(),
```

Dans `src/lib/jobs.ts` :

1. Import : ajouter `sources` à la ligne d'import du schéma (`import { agentJobs, contentComments, contents, ideas, sources } from "@/lib/db/schema";`).
2. `export type JobTargetType = "idea" | "content" | "comment" | "source";`
3. Dans `assertTarget`, avant le `throw` final :

```ts
  } else if (targetType === "source") {
    const [row] = await db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.id, targetId), eq(sources.workspaceId, workspaceId)));
    if (row) return;
  }
```

4. Dans le `sql` de `targetTitle` (listJobs), ajouter un `when` avant le `else null end` (titre de la source, sinon sa ref) :

```
      when agent_jobs.target_type = 'source' then (select coalesce(nullif(s.title, ''), s.ref) from sources s where s.id = agent_jobs.target_id)
```

5. Dans `completeJob`, juste après la garde `transcribe` existante :

```ts
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
```

6. Dans `applyFailureEffects`, après le cas `transcribe` :

```ts
  if (job.kind === "extract" && job.targetType === "source") {
    // Même raison d'import dynamique : sources.ts importe jobs.ts.
    const { markSourceFailed } = await import("@/lib/sources");
    await markSourceFailed(job.workspaceId, job.targetId, message);
  }
```

Dans `src/hooks/use-jobs.ts`, élargir la signature :

```ts
export function useJobs(targetType: "idea" | "content" | "comment" | "source", targetId: string) {
```

- [ ] **Step 4: Vérifier le passage + non-régression**

Run: `npx vitest run tests/jobs-extract.test.ts tests/jobs.test.ts tests/jobs-routes.test.ts tests/events.test.ts`
Attendu : PASS partout.

- [ ] **Step 5: Commit**

```bash
git add src/lib/events.ts src/lib/db/schema.ts src/lib/jobs.ts src/hooks/use-jobs.ts tests/jobs-extract.test.ts
git commit -m "feat: jobs ciblant une source — garde extract, échec → source failed"
```

---

### Task 3: `addSource` v1.1 — video YouTube, text long, job automatique

**Files:**
- Modify: `src/lib/sources.ts`
- Modify: `tests/sources.test.ts` (deux tests existants à réécrire, voir Step 1)

**Interfaces:**
- Consomme : `youtubeVideoId` (Task 1), `createJob` avec `targetType: "source"` (Task 2).
- Produit : `addSource(workspaceId, input)` avec `input: { ideaId: string; kind: "url"|"pdf"|"audio"|"video"|"text"; ref?: string; text?: string; title?: string; rawExcerpt?: string; createdBy?: string }` — url YouTube reclassée `video` ; `text` → `status: "extracted"` d'emblée + `ref` étiquette ; url/video → job `extract` posé (payload `{ source_kind, ref }`). Exporte aussi `enqueueExtractJob(workspaceId, { id, kind, ref, createdBy? }): Promise<void>` (non bloquant, ne throw jamais — utilisé par Task 6) et les constantes `MAX_SOURCE_TEXT_LENGTH = 200_000`, `MAX_SOURCE_EXTRACTED_LENGTH = 1_500_000`.

- [ ] **Step 1: Adapter les deux tests existants dont le contrat change**

Dans `tests/sources.test.ts` :

1. Remplacer le test `"kind pdf/audio/video refusés en v1"` (le kind `video` devient accepté, le message change) par :

```ts
  it("kind pdf/audio (upload binaire) refusés", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "pdf" as never, ref: "storage-key" })
    ).rejects.toThrow(/kind non disponible/);
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "audio" as never, ref: "storage-key" })
    ).rejects.toThrow(/kind non disponible/);
  });
```

2. Remplacer le test `"ref au-delà de MAX_SOURCE_REF_LENGTH → throw, ref exactement à la borne accepté"` (il utilisait `kind: "text"`, dont `ref` devient le contenu, borné à 200 000) par la même vérification sur une URL :

```ts
  it("ref (url) au-delà de MAX_SOURCE_REF_LENGTH → throw, exactement à la borne accepté", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const base = "https://a.test/";

    await expect(
      addSource(ws.workspaceId, {
        ideaId: idea.id, kind: "url",
        ref: base + "x".repeat(MAX_SOURCE_REF_LENGTH + 1 - base.length),
      })
    ).rejects.toThrow(/ref trop long/);

    const atLimit = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url",
      ref: base + "x".repeat(MAX_SOURCE_REF_LENGTH - base.length),
    });
    expect(atLimit.ref.length).toBe(MAX_SOURCE_REF_LENGTH);
  });
```

3. Ajouter un nouveau `describe` en fin de fichier (compléter la ligne d'import de `@/lib/sources` avec `MAX_SOURCE_TEXT_LENGTH`, et importer `listJobs` depuis `@/lib/jobs`) :

```ts
describe("sources — kinds v1.1 (video YouTube, text long, job extract)", () => {
  it("une URL YouTube déposée en url est reclassée video, avec job extract queued", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(source.kind).toBe("video");
    expect(source.status).toBe("pending");
    const jobs = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].payload).toMatchObject({ source_kind: "video", ref: source.ref });
  });

  it("un article (url non YouTube) reste url, avec job extract queued", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://www.dwarkesh.com/p/openai-huggingface",
    });
    expect(source.kind).toBe("url");
    const jobs = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ source_kind: "url" });
  });

  it("kind video explicite avec une URL non YouTube → refusé", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "video", ref: "https://vimeo.com/123" })
    ).rejects.toThrow(/URL YouTube attendue/);
  });

  it("kind text : extracted d'emblée, contenu dans extractedText, ref = étiquette, aucun job", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const long = "Ligne de titre du texte collé\n\n" + "corps ".repeat(5000); // ~30 000 caractères
    const source = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "text", text: long });
    expect(source.status).toBe("extracted");
    expect(source.extractedText).toBe(long);
    expect(source.ref).toBe("Ligne de titre du texte collé");
    expect(
      await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id })
    ).toHaveLength(0);
  });

  it("kind text sans contenu → throw ; au-delà de MAX_SOURCE_TEXT_LENGTH → throw", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "text" })
    ).rejects.toThrow(/text requis/);
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "text", text: "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1) })
    ).rejects.toThrow(/text trop long/);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/sources.test.ts`
Attendu : FAIL — `MAX_SOURCE_TEXT_LENGTH` non exporté, kind video refusé, text non extrait d'emblée.

- [ ] **Step 3: Implémenter dans `src/lib/sources.ts`**

Imports à compléter :

```ts
import { youtubeVideoId } from "@/lib/youtube";
import { createJob } from "@/lib/jobs";
```

Types et constantes (remplacent `AVAILABLE_KINDS_V1` et `AddSourceInput`) :

```ts
type AddSourceInput = {
  ideaId: string; kind: SourceKind; ref?: string; text?: string;
  title?: string; rawExcerpt?: string; createdBy?: string;
};

// url/text stockés tels quels ; video = URL YouTube uniquement (le worker
// télécharge l'audio en local, aucun binaire côté outil). pdf/audio (upload)
// attendent la table assets.
const AVAILABLE_KINDS: SourceKind[] = ["url", "text", "video"];

export const MAX_SOURCE_TITLE_LENGTH = 300;
export const MAX_SOURCE_EXCERPT_LENGTH = 10000;
export const MAX_SOURCE_REF_LENGTH = 2000;
// kind text : le contenu part directement dans extracted_text (aucune
// extraction à faire) — borne dédiée, bien au-dessus de ref.
export const MAX_SOURCE_TEXT_LENGTH = 200_000;
// attachExtraction (~25 h de transcript). Hors borne = entrée CASSÉE (throw),
// jamais tronquée en silence — même règle que les autres bornes.
export const MAX_SOURCE_EXTRACTED_LENGTH = 1_500_000;
```

Nouveau `addSource` (remplace l'actuel intégralement) :

```ts
export async function addSource(workspaceId: string, input: AddSourceInput) {
  let kind = input.kind;
  if (!AVAILABLE_KINDS.includes(kind)) {
    throw new Error("kind non disponible (pdf/audio attendent la table assets)");
  }
  if (input.title !== undefined && input.title.length > MAX_SOURCE_TITLE_LENGTH) {
    throw new Error(`title trop long (max ${MAX_SOURCE_TITLE_LENGTH} caractères)`);
  }
  if (input.rawExcerpt !== undefined && input.rawExcerpt.length > MAX_SOURCE_EXCERPT_LENGTH) {
    throw new Error(`rawExcerpt trop long (max ${MAX_SOURCE_EXCERPT_LENGTH} caractères)`);
  }

  let ref = input.ref ?? "";
  let extractedText: string | null = null; // non-null ⇒ extracted d'emblée (kind text)

  if (kind === "text") {
    // Contenu par `text` (champ dédié, long) ou par `ref` (compat MCP et
    // anciens appelants — un collage court passait par là).
    const content = input.text ?? input.ref;
    if (!content || !content.trim()) throw new Error("text requis pour kind text");
    if (content.length > MAX_SOURCE_TEXT_LENGTH) {
      throw new Error(`text trop long (max ${MAX_SOURCE_TEXT_LENGTH} caractères)`);
    }
    extractedText = content;
    // ref devient une étiquette : première ligne non vide, tronquée à 120.
    const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "texte collé";
    ref = firstLine.slice(0, 120);
  } else {
    if (!ref) throw new Error("ref requis");
    if (ref.length > MAX_SOURCE_REF_LENGTH) {
      throw new Error(`ref trop long (max ${MAX_SOURCE_REF_LENGTH} caractères)`);
    }
    // kind url/video : schéma validé ICI, au niveau lib — couvre UI + MCP
    // d'un coup. Sans ça, `javascript:`/`data:` seraient stockés tels quels.
    let parsed: URL;
    try {
      parsed = new URL(ref);
    } catch {
      throw new Error("URL invalide (http/https attendu)");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL invalide (http/https attendu)");
    }
    // Une URL YouTube déposée en `url` est reclassée `video` ; un `video`
    // explicite DOIT être une URL YouTube reconnue (pas d'autre vidéo en v1.1).
    if (kind === "url" && youtubeVideoId(ref)) kind = "video";
    if (kind === "video" && !youtubeVideoId(ref)) {
      throw new Error("kind video : URL YouTube attendue (watch, shorts, youtu.be)");
    }
  }

  const [idea] = await db.select().from(ideas)
    .where(and(eq(ideas.id, input.ideaId), eq(ideas.workspaceId, workspaceId)));
  if (!idea) throw new Error("idée introuvable dans ce workspace");

  const values: Record<string, unknown> = {
    workspaceId, ideaId: input.ideaId, kind, ref,
  };
  if (extractedText !== null) {
    values.extractedText = extractedText;
    values.status = "extracted";
  }
  if (input.title !== undefined) values.title = input.title;
  if (input.rawExcerpt !== undefined) values.rawExcerpt = input.rawExcerpt;
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;

  const [row] = await db.insert(sources).values(values as any).returning();
  if (row.status === "pending") await enqueueExtractJob(workspaceId, row);
  return row;
}

/**
 * Pose le job `extract` d'une source pending. Non bloquant : la source existe
 * déjà, un échec ici la laisse en pending (le bouton Réessayer couvre) — même
 * philosophie que les effets post-commit de jobs.ts. Exporté pour /api/clip,
 * qui insère ses sources en direct (transaction idée+source) sans addSource.
 */
export async function enqueueExtractJob(
  workspaceId: string,
  source: { id: string; kind: string; ref: string; createdBy?: string | null },
): Promise<void> {
  try {
    await createJob(workspaceId, {
      kind: "extract", targetType: "source", targetId: source.id,
      payload: { source_kind: source.kind, ref: source.ref },
      requestedBy: source.createdBy ?? "system:extract",
    });
  } catch (e) {
    console.error("création du job extract impossible (source laissée pending)", e);
  }
}
```

- [ ] **Step 4: Vérifier le passage + non-régression**

Run: `npx vitest run tests/sources.test.ts tests/jobs-extract.test.ts tests/clip.test.ts tests/e2e-flow.test.ts`
Attendu : PASS. (Si un test existant hors de ceux adaptés au Step 1 casse sur le message « kind non disponible en v1 », le mettre à jour vers `/kind non disponible/` — c'est le seul changement de message de cette task.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/sources.ts tests/sources.test.ts
git commit -m "feat: addSource v1.1 — video YouTube, text long extrait d'emblée, job extract auto"
```

---

### Task 4: `attachExtraction` (borne, titre), événements `source.updated`, `retrySourceExtraction`

**Files:**
- Modify: `src/lib/sources.ts`
- Test: `tests/sources.test.ts` (nouveau `describe`)

**Interfaces:**
- Consomme : `bus` de `@/lib/events` ; `listJobs`, `retryJob` de `@/lib/jobs` (imports statiques — jobs.ts n'importe sources.ts que dynamiquement, pas de cycle).
- Produit : `attachExtraction` borné à `MAX_SOURCE_EXTRACTED_LENGTH`, pose `title` depuis `extracted_meta.title` si la source n'en avait pas, publie `source.updated` ; `markSourceFailed` publie `source.updated` ; `retrySourceExtraction(workspaceId, sourceId): Promise<Source | null>` — `null` si introuvable, throw « réessai refusé : … » si non `failed`, sinon source repassée `pending` + job requeued (utilisé par la route de Task 5).

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter en fin de `tests/sources.test.ts` (compléter les imports : `retrySourceExtraction`, `MAX_SOURCE_EXTRACTED_LENGTH` depuis `@/lib/sources` ; `claimJob`, `failJob` depuis `@/lib/jobs` ; `bus` et le type `WorkspaceEvent` depuis `@/lib/events`) :

```ts
describe("sources — extraction : borne, titre, réessai, événements", () => {
  it("attachExtraction au-delà de MAX_SOURCE_EXTRACTED_LENGTH → throw", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://exemple.fr/b" });
    await expect(
      attachExtraction(ws.workspaceId, source.id, { extractedText: "x".repeat(MAX_SOURCE_EXTRACTED_LENGTH + 1) })
    ).rejects.toThrow(/extractedText trop long/);
  });

  it("attachExtraction pose le titre depuis extracted_meta.title, sans jamais écraser un titre existant", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    const sansTitre = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://exemple.fr/t1" });
    const r1 = await attachExtraction(ws.workspaceId, sansTitre.id, {
      extractedText: "corps", extractedMeta: { title: "Titre de la page" },
    });
    expect(r1?.title).toBe("Titre de la page");

    const avecTitre = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/t2", title: "Mon titre",
    });
    const r2 = await attachExtraction(ws.workspaceId, avecTitre.id, {
      extractedText: "corps", extractedMeta: { title: "Autre" },
    });
    expect(r2?.title).toBe("Mon titre");
  });

  it("retrySourceExtraction : failed → pending + job requeued (attempts+1) ; refus si non failed", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://exemple.fr/r" });
    const [job] = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom"); // effet Task 2 : source → failed

    const retried = await retrySourceExtraction(ws.workspaceId, source.id);
    expect(retried?.status).toBe("pending");
    const jobs = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].attempts).toBe(1);

    await expect(retrySourceExtraction(ws.workspaceId, source.id)).rejects.toThrow(/réessai refusé/);
    expect(await retrySourceExtraction(ws.workspaceId, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("source.updated publié sur attachExtraction et markSourceFailed", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://exemple.fr/e" });
    const events: WorkspaceEvent[] = [];
    const off = bus.subscribe(ws.workspaceId, (e) => events.push(e));
    try {
      await attachExtraction(ws.workspaceId, source.id, { extractedText: "corps" });
      await markSourceFailed(ws.workspaceId, source.id, "re-cassée");
    } finally {
      off();
    }
    // Prédicat de type : un simple filter ne rétrécit pas l'union WorkspaceEvent
    const sourceEvents = events.filter(
      (e): e is Extract<WorkspaceEvent, { type: "source.updated" }> => e.type === "source.updated"
    );
    expect(sourceEvents.map((e) => e.status)).toEqual(["extracted", "failed"]);
    expect(sourceEvents[0]).toMatchObject({ sourceId: source.id, ideaId: idea.id });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/sources.test.ts`
Attendu : FAIL — `retrySourceExtraction`/`MAX_SOURCE_EXTRACTED_LENGTH` inexistants, pas d'événements, pas de borne.

- [ ] **Step 3: Implémenter dans `src/lib/sources.ts`**

Imports à compléter :

```ts
import { bus } from "@/lib/events";
import { createJob, listJobs, retryJob } from "@/lib/jobs";
```

`attachExtraction` (remplace l'actuel) :

```ts
export async function attachExtraction(
  workspaceId: string, sourceId: string,
  input: { extractedText: string; extractedMeta?: Record<string, unknown> }
) {
  if (input.extractedText.length > MAX_SOURCE_EXTRACTED_LENGTH) {
    throw new Error(`extractedText trop long (max ${MAX_SOURCE_EXTRACTED_LENGTH} caractères)`);
  }
  const existing = await getSource(workspaceId, sourceId);
  if (!existing) return null;

  const update: Record<string, unknown> = {
    status: "extracted",
    extractedText: input.extractedText,
    updatedAt: new Date(),
  };
  if (input.extractedMeta !== undefined) update.extractedMeta = input.extractedMeta;
  // Une URL déposée sans titre en gagne un si l'extracteur en fournit —
  // jamais d'écrasement d'un titre posé par l'humain.
  const metaTitle = input.extractedMeta?.title;
  if (!existing.title && typeof metaTitle === "string" && metaTitle.trim()) {
    update.title = metaTitle.trim().slice(0, MAX_SOURCE_TITLE_LENGTH);
  }

  const [row] = await db.update(sources)
    .set(update as any)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .returning();
  if (!row) return null;
  bus.publish(workspaceId, { type: "source.updated", sourceId: row.id, ideaId: row.ideaId, status: row.status });
  return row;
}
```

`markSourceFailed` : après le `.returning()`, publier avant de rendre :

```ts
  if (row) bus.publish(workspaceId, { type: "source.updated", sourceId: row.id, ideaId: row.ideaId, status: row.status });
  return row ?? null;
```

Nouvelle fonction :

```ts
/** Source failed → pending, et repose le job extract (retry du dernier failed, sinon un neuf). */
export async function retrySourceExtraction(workspaceId: string, sourceId: string) {
  const source = await getSource(workspaceId, sourceId);
  if (!source) return null;
  if (source.status !== "failed") {
    throw new Error(`réessai refusé : source en statut ${source.status}`);
  }
  const [row] = await db.update(sources)
    .set({ status: "pending", extractedMeta: {}, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .returning();
  if (!row) return null;

  const failedJobs = await listJobs(workspaceId, {
    kind: "extract", targetType: "source", targetId: sourceId, status: "failed",
  });
  if (failedJobs[0]) {
    // retryJob garde l'historique (attempts, previous_errors). S'il refuse
    // (le job a bougé entre-temps : double clic, worker), on repose un neuf —
    // createJob coalesce sur un éventuel job actif.
    try {
      await retryJob(workspaceId, failedJobs[0].id);
    } catch {
      await enqueueExtractJob(workspaceId, row);
    }
  } else {
    await enqueueExtractJob(workspaceId, row);
  }
  bus.publish(workspaceId, { type: "source.updated", sourceId: row.id, ideaId: row.ideaId, status: row.status });
  return row;
}
```

- [ ] **Step 4: Vérifier le passage + non-régression complète des libs**

Run: `npx vitest run tests/sources.test.ts tests/jobs-extract.test.ts tests/jobs.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sources.ts tests/sources.test.ts
git commit -m "feat: attachExtraction borné + titre auto, retrySourceExtraction, événements source.updated"
```

---

### Task 5: Routes — dépôt `text`, `POST /api/sources/[id]/retry`

**Files:**
- Modify: `src/app/api/ideas/[id]/sources/route.ts` (POST : champ `text`)
- Create: `src/app/api/sources/[id]/retry/route.ts`
- Test: `tests/sources-routes.test.ts` (nouveau fichier)

**Interfaces:**
- Consomme : `addSource` (Task 3), `retrySourceExtraction` (Task 4), helpers de test `signUpTestUser`, `authedReq`, `req` (`tests/helpers.ts`, mêmes usages que `tests/jobs-routes.test.ts`).
- Produit : `POST /api/ideas/[id]/sources` accepte `{ kind?, ref?, text?, title?, rawExcerpt? }` (kind par défaut : `"text"` si seul `text` est fourni, sinon `"url"`) ; `POST /api/sources/[id]/retry` → 200 source, 404 introuvable, 409 non-failed, 401 sans session. L'UI (Task 8) consomme ces deux contrats.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// tests/sources-routes.test.ts
import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { POST as addRoute } from "@/app/api/ideas/[id]/sources/route";
import { POST as retryRoute } from "@/app/api/sources/[id]/retry/route";
import { createIdea } from "@/lib/ideas";
import { addSource, getSource } from "@/lib/sources";
import { claimJob, failJob, listJobs } from "@/lib/jobs";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/ideas/[id]/sources — v1.1", () => {
  it("text long (au-delà de l'ancienne borne ref) → extracted d'emblée, ref = étiquette", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const long = "Titre du collage\n" + "corps ".repeat(3000); // ~18 000 caractères
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`, jsonInit({ kind: "text", text: long })),
      params(idea.id)
    );
    expect(r.status).toBe(200);
    const source = await r.json();
    expect(source.status).toBe("extracted");
    expect(source.ref).toBe("Titre du collage");
  });

  it("URL YouTube → source video pending + job extract", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`,
        jsonInit({ kind: "url", ref: "https://youtu.be/dQw4w9WgXcQ" })),
      params(idea.id)
    );
    expect(r.status).toBe(200);
    const source = await r.json();
    expect(source.kind).toBe("video");
    expect(
      (await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id }))
    ).toHaveLength(1);
  });

  it("ni ref ni text → 400", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`, jsonInit({ kind: "url" })),
      params(idea.id)
    );
    expect(r.status).toBe(400);
  });
});

describe("POST /api/sources/[id]/retry", () => {
  it("failed → 200 pending ; non failed → 409 ; autre workspace → 404 ; sans session → 401", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/retry",
    });
    const [job] = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");

    expect((await retryRoute(req(`/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id))).status).toBe(401);
    expect((await retryRoute(await authedReq(autre, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id))).status).toBe(404);

    const ok = await retryRoute(await authedReq(ws, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("pending");
    expect((await getSource(ws.workspaceId, source.id))?.status).toBe("pending");

    const again = await retryRoute(await authedReq(ws, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id));
    expect(again.status).toBe(409);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/sources-routes.test.ts`
Attendu : FAIL — module retry inexistant ; `text` ignoré par la route de dépôt.

- [ ] **Step 3: Implémenter**

Dans `src/app/api/ideas/[id]/sources/route.ts`, remplacer le corps du `POST` (le `try` garde son mapping d'erreurs, complété) :

```ts
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const ideaId = (await params).id;
    const { kind, ref, text, title, rawExcerpt } = await req.json();
    if (!ref && !text)
      return NextResponse.json({ error: "ref ou text requis" }, { status: 400 });
    const source = await addSource(workspaceId, {
      ideaId,
      kind: kind ?? (text && !ref ? "text" : "url"),
      ref, text, title, rawExcerpt, createdBy: userId,
    });
    return NextResponse.json(source);
```

Et dans le `catch`, ajouter deux mappings 400 au même niveau que les existants :

```ts
    if (e instanceof Error && e.message.includes("requis"))
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("YouTube attendue"))
      return NextResponse.json({ error: e.message }, { status: 400 });
```

Créer `src/app/api/sources/[id]/retry/route.ts` (même squelette que `jobs/[id]/retry`) :

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { retrySourceExtraction } from "@/lib/sources";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const source = await retrySourceExtraction(workspaceId, (await params).id);
    if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(source);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("réessai refusé"))
      return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
```

- [ ] **Step 4: Vérifier le passage**

Run: `npx vitest run tests/sources-routes.test.ts tests/auth-workspace.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/ideas/[id]/sources/route.ts src/app/api/sources/[id]/retry/route.ts tests/sources-routes.test.ts
git commit -m "feat: routes sources — dépôt de texte long, réessai d'extraction"
```

---

### Task 6: `/api/clip` — classification video + job extract

**Files:**
- Modify: `src/app/api/clip/route.ts`
- Test: `tests/clip.test.ts` (nouveau `describe`)

**Interfaces:**
- Consomme : `youtubeVideoId` (Task 1), `enqueueExtractJob` (Task 3). Le harnais de `tests/clip.test.ts` (helper local `clipRequest(body, token)`, `generateMcpToken`).
- Produit : un clip d'URL YouTube crée une source `video` ; toute source clippée (`url` ou `video`) a son job `extract` queued. Le contrat de réponse `{ ideaId, sourceId }` est inchangé.

- [ ] **Step 1: Écrire les tests qui échouent**

Ajouter dans `tests/clip.test.ts` (imports à compléter : `listJobs` depuis `@/lib/jobs`) :

```ts
describe("clip — classification et job extract (vague sources & extraction)", () => {
  it("clip d'une URL YouTube → source video + job extract queued", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "clip");
    const res = await POST(clipRequest({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Une vidéo" }, token));
    expect(res.status).toBe(200);
    const { sourceId } = await res.json();
    const source = await getSource(ws.workspaceId, sourceId);
    expect(source?.kind).toBe("video");
    const jobs = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: sourceId });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].payload).toMatchObject({ source_kind: "video", ref: "https://youtu.be/dQw4w9WgXcQ" });
  });

  it("clip d'un article → source url + job extract queued", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "clip");
    const res = await POST(clipRequest({ url: "https://www.dwarkesh.com/p/openai-huggingface" }, token));
    expect(res.status).toBe(200);
    const { sourceId } = await res.json();
    expect((await getSource(ws.workspaceId, sourceId))?.kind).toBe("url");
    expect(
      await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: sourceId })
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/clip.test.ts`
Attendu : FAIL sur les deux nouveaux tests (kind `url`, aucun job) ; tous les tests existants PASS.

- [ ] **Step 3: Implémenter dans `src/app/api/clip/route.ts`**

Imports :

```ts
import { youtubeVideoId } from "@/lib/youtube";
import { enqueueExtractJob } from "@/lib/sources";
```

Avant la transaction (après les validations d'URL) :

```ts
    // Même classification que la lib addSource (clip insère en direct pour
    // la transaction idée+source, il doit donc classer lui-même).
    const kind = youtubeVideoId(url) ? ("video" as const) : ("url" as const);
```

Dans l'insert de la source, remplacer `kind: "url"` par `kind`.

Après la transaction, avant le `return json(result)` :

```ts
    // Non bloquant (même contrat qu'addSource) : si la pose du job échoue,
    // la source reste pending et le bouton Réessayer couvre.
    await enqueueExtractJob(auth.workspaceId, {
      id: result.sourceId, kind, ref: url, createdBy: "clipper",
    });
```

- [ ] **Step 4: Vérifier le passage**

Run: `npx vitest run tests/clip.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/clip/route.ts tests/clip.test.ts
git commit -m "feat: clip — URL YouTube classée video, job extract posé au clip"
```

---

### Task 7: MCP — `add_source` (text/video), `list_sources` (idea_id)

**Files:**
- Modify: `src/app/api/[transport]/route.ts` (outils `add_source`, `list_sources`, description d'`attach_extraction`)
- Test: `tests/mcp-sources.test.ts` (nouveau fichier)

**Interfaces:**
- Consomme : `addSource`/`listSources` (Tasks 3-4), harnais `callMcpTool(token, name, args)` + `generateMcpToken` (mêmes usages que `tests/mcp-create-idea.test.ts` — `callMcpTool` rend `{ status, texte, rpc }`).
- Produit : `add_source` accepte `ref` optionnel + `text` optionnel ; `list_sources` accepte `idea_id` optionnel. Contrats consommés par le worker (Task 9) et tout agent rédacteur.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// tests/mcp-sources.test.ts
import { describe, it, expect } from "vitest";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { addSource } from "@/lib/sources";
import { listJobs } from "@/lib/jobs";
import { signUpTestUser, callMcpTool } from "./helpers";

describe("MCP — sources v1.1", () => {
  it("add_source : URL YouTube reclassée video + job extract ; text long extrait d'emblée", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "test");
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    const rVideo = await callMcpTool(token, "add_source", {
      idea_id: idea.id, kind: "url", ref: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(rVideo.status).toBe(200);
    const video = JSON.parse(rVideo.texte);
    expect(video.kind).toBe("video");
    expect(
      await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: video.id })
    ).toHaveLength(1);

    const long = "Notes de veille\n" + "contenu ".repeat(1000);
    const rText = await callMcpTool(token, "add_source", { idea_id: idea.id, kind: "text", text: long });
    expect(rText.status).toBe(200);
    const texte = JSON.parse(rText.texte);
    expect(texte.status).toBe("extracted");
    expect(texte.extractedText).toBe(long);
  });

  it("list_sources filtre par idea_id", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "test");
    const ideaA = await createIdea(ws.workspaceId, { title: "A" });
    const ideaB = await createIdea(ws.workspaceId, { title: "B" });
    const sA = await addSource(ws.workspaceId, { ideaId: ideaA.id, kind: "text", text: "notes A" });
    await addSource(ws.workspaceId, { ideaId: ideaB.id, kind: "text", text: "notes B" });

    const r = await callMcpTool(token, "list_sources", { idea_id: ideaA.id });
    expect(r.status).toBe(200);
    const rows = JSON.parse(r.texte);
    expect(rows.map((s: { id: string }) => s.id)).toEqual([sA.id]);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx vitest run tests/mcp-sources.test.ts`
Attendu : FAIL — `add_source` exige `ref` (validation Zod) et ignore `text` ; `list_sources` ignore `idea_id`.

- [ ] **Step 3: Implémenter dans `src/app/api/[transport]/route.ts`**

Remplacer l'outil `add_source` :

```ts
    server.registerTool(
      "add_source",
      {
        description: "Dépose une source sur une idée. kind url/video : ref = URL (une URL YouTube passée en url est reclassée video) → status pending + job extract pour le worker. kind text : passe le contenu (long) dans `text` → extraite d'emblée. pdf/audio (upload binaire) refusés en v1.1.",
        inputSchema: {
          idea_id: z.string().uuid(),
          kind: z.enum(["url", "pdf", "audio", "video", "text"]),
          ref: z.string().optional(),
          text: z.string().optional(),
          title: z.string().optional(),
          raw_excerpt: z.string().optional(),
        },
      },
      async ({ idea_id, kind, ref, text, title, raw_excerpt }, extra) =>
        json(await addSource(wsOf(extra), {
          ideaId: idea_id, kind, ref, text, title, rawExcerpt: raw_excerpt,
        }))
    );
```

Remplacer l'outil `list_sources` :

```ts
    server.registerTool(
      "list_sources",
      {
        description: "Liste les sources du workspace (url/video/text). Filtres optionnels : status ('pending' = extraction en attente), idea_id (les sources d'une idée).",
        inputSchema: {
          status: z.enum(["pending", "extracted", "failed"]).optional(),
          idea_id: z.string().uuid().optional(),
        },
      },
      async ({ status, idea_id }, extra) =>
        json(await listSources(wsOf(extra), { status, ideaId: idea_id }))
    );
```

Dans la description d'`attach_extraction`, ajouter à la fin : « Borné à 1 500 000 caractères. Le worker enchaîne avec complete_job — un job extract ne passe done que si la source est extraite. »

- [ ] **Step 4: Vérifier le passage + non-régression MCP**

Run: `npx vitest run tests/mcp-sources.test.ts tests/mcp-jobs.test.ts tests/mcp-auth.test.ts tests/mcp-create-idea.test.ts`
Attendu : PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/[transport]/route.ts" tests/mcp-sources.test.ts
git commit -m "feat: MCP — add_source text/video, list_sources par idée"
```

---

### Task 8: UI fiche idée — badge YouTube, texte long, réessai, panneau extrait, live

**Files:**
- Modify: `src/components/idea-detail.tsx`

**Interfaces:**
- Consomme : `youtubeVideoId` (Task 1, module pur — importable côté client), `useWorkspaceEvents` (`@/hooks/use-workspace-events`), routes de Task 5, type d'événement `source.updated` (Task 2).
- Produit : rien de nouveau pour les autres tasks — c'est la surface humaine.

- [ ] **Step 1: Implémenter (pas de test unitaire UI dans ce repo pour ce composant — la vérification est typecheck + suite complète + contrôle visuel)**

Dans `src/components/idea-detail.tsx` :

1. Imports :

```ts
import { youtubeVideoId } from "@/lib/youtube";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";
```

2. Type `Source` — remplacer par :

```ts
type Source = {
  id: string; kind: string; ref: string; title: string;
  extractedText: string; extractedMeta: Record<string, unknown>; status: string;
};
```

3. Live : après le `useEffect` de chargement, s'abonner aux extractions de CETTE idée :

```ts
  useWorkspaceEvents((e) => {
    if (e.type === "source.updated" && e.ideaId === ideaId) load();
  });
```

4. `addSourceSubmit` — remplacer la construction du corps (le texte long part dans `text`, plus jamais dans `ref`) :

```ts
    const body = url
      ? { kind: "url", ref: url, rawExcerpt: text || undefined }
      : { kind: "text", text };
```

(supprimer les variables `kind`/`ref` locales devenues inutiles ; le garde-fou `if (!url && !text)` remplace `if (!ref)` avec le même message).

5. Sous l'`Input` URL, badge de détection :

```tsx
          {youtubeVideoId(sourceUrl.trim()) && (
            <p className="text-xs text-accent">
              Vidéo YouTube détectée — l&apos;audio sera transcrit en local (mlx-whisper).
            </p>
          )}
```

5 bis. Sous le `Textarea` texte, compteur de caractères au-delà de 1000 (spec §4) :

```tsx
          {sourceText.length > 1000 && (
            <p className="text-right text-[11px] text-faint tabular-nums">
              {sourceText.length.toLocaleString("fr-FR")} / 200 000 caractères
            </p>
          )}
```

6. Ligne source — ajouter l'étiquette de kind à gauche du titre (dans le `<button>`, avant le `<span>` titre) :

```tsx
                    <span className="shrink-0 text-[10px] tracking-widest text-faint uppercase">
                      {s.kind === "video" ? "vidéo" : s.kind === "url" ? "article" : "texte"}
                    </span>
```

7. Après le `</button>` de chaque ligne, bloc d'échec avec raison + réessai :

```tsx
                  {s.status === "failed" && (
                    <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/10 p-2">
                      <p className="min-w-0 flex-1 text-xs text-danger">
                        {typeof s.extractedMeta.error === "string" && s.extractedMeta.error
                          ? s.extractedMeta.error
                          : "extraction échouée"}
                      </p>
                      <Button variant="outline" onClick={() => retrySource(s.id)}>Réessayer</Button>
                    </div>
                  )}
```

avec, à côté d'`addSourceSubmit` :

```ts
  async function retrySource(id: string) {
    const res = await fetch(`/api/sources/${id}/retry`, { method: "POST" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setSourceError(message ?? "Réessai impossible.");
      return;
    }
    setSourceError(null);
    load();
  }
```

8. Panneau extrait — remplacer le `<pre>` tronqué à 500 caractères par le texte complet + compteur de mots :

```tsx
                  {extractable && openSourceId === s.id && (
                    <div className="mt-2 rounded-lg border border-line bg-bg">
                      <p className="border-b border-line px-3 py-1.5 text-[11px] text-faint tabular-nums">
                        {s.extractedText.split(/\s+/).filter(Boolean).length} mots
                      </p>
                      <pre className="max-h-72 overflow-auto p-3 text-xs leading-5 whitespace-pre-wrap">
                        {s.extractedText}
                      </pre>
                    </div>
                  )}
```

9. Sous la liste des sources (dans le même `SectionCard`), indice worker quand une extraction attend :

```tsx
        {sourcesList.some((s) => s.status === "pending") && (
          <p className="mt-2 text-xs text-faint">
            Extraction en attente d&apos;un worker — lancer <code>node scripts/extract-worker.mjs</code> sur le Mac.
          </p>
        )}
```

- [ ] **Step 2: Vérifier types + suite complète**

Run: `npx tsc --noEmit` (timeout 120 s) puis `npx vitest run`
Attendu : zéro erreur TypeScript, suite verte.

- [ ] **Step 3: Contrôle visuel rapide (optionnel mais recommandé)**

`npm run dev` (port 3003), ouvrir une idée : coller une URL YouTube → badge « Vidéo YouTube détectée » ; coller un texte de plus de 2000 caractères → source « texte » extraite d'emblée, panneau complet avec compteur de mots.

- [ ] **Step 4: Commit**

```bash
git add src/components/idea-detail.tsx
git commit -m "feat: fiche idée — badge YouTube, texte long, réessai d'extraction, panneau extrait, live SSE"
```

---

### Task 9: Worker `scripts/extract-worker.mjs` + deps + README

**Files:**
- Modify: `package.json` + `package-lock.json` (devDeps `@mozilla/readability`, `linkedom`)
- Create: `scripts/extract-worker.mjs`
- Modify: `README.md` (tableau des kinds worker + section extraction)

**Interfaces:**
- Consomme : outils MCP existants `list_jobs`, `claim_job`, `heartbeat_job`, `attach_extraction`, `complete_job`, `fail_job` (les résultats MCP sont `{ content: [{ type: "text", text: JSON }] }` ; une erreur métier arrive en `{ error }` DANS le JSON, pas en exception JSON-RPC). Binaires locaux `yt-dlp` et `mlx_whisper` (shims pyenv). Env : `CS_MCP_URL`, `CS_MCP_TOKEN`, `CS_WHISPER_MODEL` (optionnel).
- Produit : le consommateur des jobs `extract`. Aucun autre code ne l'importe.

- [ ] **Step 1: Installer les deps (légitimité vérifiée : Readability est le module officiel Mozilla du mode lecture Firefox ; linkedom est le DOM léger de WebReflection)**

```bash
npm install --save-dev @mozilla/readability linkedom
```

- [ ] **Step 2: Écrire le script**

```js
#!/usr/bin/env node
// scripts/extract-worker.mjs — worker d'extraction des sources.
//
// Tourne sur le Mac (là où vivent yt-dlp et mlx_whisper) et parle
// EXCLUSIVEMENT MCP à content-studio, comme n'importe quel worker — jamais
// la base en direct.
//
//   CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… \
//     node scripts/extract-worker.mjs [--once]
//
// kinds pris en charge (payload.source_kind) :
//   url   → fetch + Readability (HTML uniquement — un PDF est refusé avec un
//           message qui invite à déposer le texte à la main)
//   video → yt-dlp -x (audio temporaire) + mlx_whisper (large-v3-turbo)
// Tout échec → fail_job(message lisible) : la source passe failed côté outil,
// le bouton Réessayer la remet en pending.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const run = promisify(execFile);
const MCP_URL = process.env.CS_MCP_URL;
const MCP_TOKEN = process.env.CS_MCP_TOKEN;
const WHISPER_MODEL = process.env.CS_WHISPER_MODEL ?? "mlx-community/whisper-large-v3-turbo";
const ONCE = process.argv.includes("--once");
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000; // le serveur bascule un running en failed après 10 min de silence
const WORKER_LABEL = `extract-worker@${hostname()}`;

if (!MCP_URL || !MCP_TOKEN) {
  console.error("CS_MCP_URL et CS_MCP_TOKEN requis (token workspace : UI → Réglages → Tokens MCP)");
  process.exit(1);
}

let client;
async function connect() {
  client = new Client({ name: "extract-worker", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
}

// Appel d'outil + décodage du JSON métier. Une erreur métier ({ error }) est
// convertie en exception : chaque appelant décide (claim perdu = on passe).
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const data = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (data && typeof data === "object" && !Array.isArray(data) && "error" in data) {
    throw new Error(`${name}: ${data.error}`);
  }
  return data;
}

// ---- extracteurs -----------------------------------------------------------

async function extractUrl(ref) {
  const res = await fetch(ref, {
    signal: AbortSignal.timeout(30_000),
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) {
    throw new Error(`contenu non HTML (${type.split(";")[0] || "type inconnu"}) — déposer le texte à la main`);
  }
  const { document } = parseHTML(await res.text());
  const article = new Readability(document).parse();
  if (!article || !article.textContent?.trim()) {
    throw new Error("Readability n'a rien extrait de cette page");
  }
  return {
    text: article.textContent.trim(),
    meta: {
      title: article.title || undefined,
      byline: article.byline || undefined,
      site: article.siteName || undefined,
      lang: article.lang || undefined,
      tool: "extract-worker/readability",
    },
  };
}

async function extractVideo(ref) {
  const dir = await mkdtemp(join(tmpdir(), "cs-extract-"));
  try {
    // -j --no-simulate : télécharge ET rend les métadonnées JSON sur stdout.
    const { stdout } = await run(
      "yt-dlp",
      ["--no-playlist", "-x", "--audio-format", "m4a",
        "-o", join(dir, "audio.%(ext)s"), "-j", "--no-simulate", ref],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    await run(
      "mlx_whisper",
      [join(dir, "audio.m4a"), "--model", WHISPER_MODEL,
        "--output-format", "txt", "--output-dir", dir],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const text = (await readFile(join(dir, "audio.txt"), "utf8")).trim();
    if (!text) throw new Error("transcript vide (mlx_whisper n'a rien produit)");
    return {
      text,
      meta: {
        title: typeof info.title === "string" ? info.title : undefined,
        duration_s: typeof info.duration === "number" ? info.duration : undefined,
        model: WHISPER_MODEL,
        tool: "extract-worker/yt-dlp+mlx-whisper",
      },
    };
  } catch (e) {
    // Binaire absent (ENOENT) : message actionnable plutôt qu'un spawn error.
    if (e?.code === "ENOENT") throw new Error(`binaire manquant : ${e.path ?? "yt-dlp/mlx_whisper"} (PATH du worker)`);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- boucle ---------------------------------------------------------------

async function processJob(job) {
  try {
    await call("claim_job", { job_id: job.id, worker_label: WORKER_LABEL });
  } catch (e) {
    console.log(`claim perdu ${job.id} (${e.message})`);
    return;
  }
  const heartbeat = setInterval(() => {
    call("heartbeat_job", { job_id: job.id }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    const { source_kind, ref } = job.payload ?? {};
    if (typeof ref !== "string" || !ref) throw new Error("payload.ref manquant");
    console.log(`extract ${source_kind} ${ref}`);
    const { text, meta } = await (source_kind === "video" ? extractVideo(ref) : extractUrl(ref));
    await call("attach_extraction", {
      source_id: job.targetId, extracted_text: text, extracted_meta: meta,
    });
    await call("complete_job", { job_id: job.id });
    console.log(`done ${job.id} (${text.length} caractères)`);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`échec ${job.id} : ${message}`);
    await call("fail_job", { job_id: job.id, error: message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick() {
  const jobs = await call("list_jobs", { status: "queued", kind: "extract" });
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job.targetType !== "source") continue;
    await processJob(job);
  }
}

await connect();
console.log(`${WORKER_LABEL} branché sur ${MCP_URL}${ONCE ? " (--once)" : ""}`);
do {
  try {
    await tick();
  } catch (e) {
    console.error(`boucle : ${e instanceof Error ? e.message : e}`);
    // session MCP expirée ou serveur redémarré : on se rebranche
    try { await connect(); } catch { /* retentera au prochain tour */ }
  }
  if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS));
} while (!ONCE);
process.exit(0);
```

- [ ] **Step 3: Vérifications du script**

Run: `node --check scripts/extract-worker.mjs` → aucune sortie (syntaxe OK).
Run: `node scripts/extract-worker.mjs` sans env → message « CS_MCP_URL et CS_MCP_TOKEN requis… », exit 1.

- [ ] **Step 4: Smoke de bout en bout (si la base et le dev server sont disponibles)**

1. `npm run dev` dans un terminal (port 3003), créer un token MCP dans l'UI (Réglages → Tokens MCP).
2. Déposer une source URL sur une idée (par l'UI, ou `add_source` MCP).
3. `CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… node scripts/extract-worker.mjs --once`
4. Attendu : log `extract url …` puis `done …` ; dans l'UI la source passe « extracted » en live (SSE) et le panneau montre le texte.
   Si l'environnement ne le permet pas, le noter dans le message de commit (« smoke e2e non joué »).

- [ ] **Step 5: README**

Dans `README.md` :

1. Ajouter la ligne au tableau des kinds worker (après la ligne `transcribe`) :

```markdown
| `extract` | dépôt d'une source url/vidéo (automatique), ou « Réessayer » sur une source échouée | worker `attach_extraction(source_id, texte, meta)` puis `complete_job` — le complete est refusé tant que la source n'est pas extraite |
```

2. Juste après ce tableau, ajouter :

```markdown
### Extraction des sources : le worker fourni

Les jobs `extract` (articles → Readability, vidéos YouTube → yt-dlp +
mlx-whisper en local) ont un worker déterministe prêt à l'emploi — aucun
token LLM :

​```sh
CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… \
  node scripts/extract-worker.mjs        # boucle (poll 15 s) ; --once pour un seul passage
​```

Prérequis sur la machine du worker : `yt-dlp` et `mlx_whisper` dans le PATH
(Apple Silicon pour mlx). Un agent MCP peut aussi consommer ces jobs à la
main en suivant le tableau ci-dessus.
```

(retirer les zero-width spaces `​` devant les fences imbriquées lors de la copie réelle.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json scripts/extract-worker.mjs README.md
git commit -m "feat: worker d'extraction dédié (Readability, yt-dlp + mlx-whisper) + doc worker"
```

---

### Task 10: Vérification finale et clôture

**Files:**
- Modify: `docs/specs/2026-08-31-sources-extraction-design.md` (ligne Statut)

- [ ] **Step 1: Suite complète + types**

Run: `npx vitest run` puis `npx tsc --noEmit` (timeout 120 s)
Attendu : tout vert. Corriger ici toute régression avant de continuer.

- [ ] **Step 2: Cohérence spec ↔ code**

Relire `docs/specs/2026-08-31-sources-extraction-design.md` section par section et vérifier que chaque exigence a son implémentation (kinds §1.1, garde §2.2, effets d'échec §2.3, événements §2.4, worker §3, UI §4, MCP §5). Noter toute déviation assumée dans la spec (une phrase suffit).

- [ ] **Step 3: Mettre à jour le statut de la spec**

Remplacer `**Statut** : validé (design), plan à venir` par `**Statut** : implémenté (plan docs/plans/2026-08-31-sources-extraction.md)`.

- [ ] **Step 4: Commit final**

```bash
git add docs/specs/2026-08-31-sources-extraction-design.md
git commit -m "docs: spec sources & extraction — statut implémenté"
```
