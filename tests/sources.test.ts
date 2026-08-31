import { describe, it, expect } from "vitest";
import { createIdea } from "@/lib/ideas";
import {
  addSource, listSources, getSource, attachExtraction, markSourceFailed,
  MAX_SOURCE_EXCERPT_LENGTH, MAX_SOURCE_REF_LENGTH, MAX_SOURCE_TITLE_LENGTH, MAX_SOURCE_TEXT_LENGTH,
} from "@/lib/sources";
import { listJobs } from "@/lib/jobs";
import { signUpTestUser } from "./helpers";

describe("sources — cycle pending → extracted", () => {
  it("addSource crée en pending, attachExtraction passe en extracted", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée avec source" });

    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://example.com/article",
      title: "Un article", createdBy: "claude-e2e",
    });
    expect(source.status).toBe("pending");
    expect(source.ref).toBe("https://example.com/article");

    const attached = await attachExtraction(ws.workspaceId, source.id, {
      extractedText: "Le texte long extrait par l'agent.",
      extractedMeta: { wordCount: 6 },
    });
    expect(attached?.status).toBe("extracted");
    expect(attached?.extractedText).toBe("Le texte long extrait par l'agent.");
    expect(attached?.extractedMeta).toEqual({ wordCount: 6 });

    const fetched = await getSource(ws.workspaceId, source.id);
    expect(fetched?.status).toBe("extracted");
  });

  it("markSourceFailed pose failed + raison dans extractedMeta.error", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://example.com",
    });

    const failed = await markSourceFailed(ws.workspaceId, source.id, "extraction impossible : 404");
    expect(failed?.status).toBe("failed");
    expect(failed?.extractedMeta).toEqual({ error: "extraction impossible : 404" });
  });

  it("listSources filtre par ideaId et par status", async () => {
    const ws = await signUpTestUser();
    const ideaA = await createIdea(ws.workspaceId, { title: "A" });
    const ideaB = await createIdea(ws.workspaceId, { title: "B" });
    const s1 = await addSource(ws.workspaceId, { ideaId: ideaA.id, kind: "url", ref: "https://a.test" });
    await addSource(ws.workspaceId, { ideaId: ideaB.id, kind: "url", ref: "https://b.test" });
    await attachExtraction(ws.workspaceId, s1.id, { extractedText: "x" });

    expect((await listSources(ws.workspaceId, { ideaId: ideaA.id })).map((s) => s.id)).toEqual([s1.id]);
    expect((await listSources(ws.workspaceId, { status: "extracted" })).map((s) => s.id)).toEqual([s1.id]);
    expect((await listSources(ws.workspaceId, {})).length).toBe(2);
  });

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

  it("kind url : schéma javascript: refusé", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "javascript:alert(1)" })
    ).rejects.toThrow(/URL invalide/);
  });

  it("kind url : schéma https accepté", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/page",
    });
    expect(source.ref).toBe("https://exemple.fr/page");
  });
});

// Durcissement (revue finale, vague cockpit) : ref/title/rawExcerpt n'avaient
// aucune borne de longueur, contrairement au style déjà en place dans
// gauges.ts (MAX_NAME_LENGTH, MAX_URL_LENGTH…). Une valeur hors bornes est
// une entrée CASSÉE (throw), jamais tronquée en silence — /api/clip réutilise
// ces MÊMES constantes (voir tests/clip.test.ts).
describe("sources — bornes anti-DoS (ref/title/rawExcerpt)", () => {
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

  it("title au-delà de MAX_SOURCE_TITLE_LENGTH → throw", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    await expect(
      addSource(ws.workspaceId, {
        ideaId: idea.id, kind: "url", ref: "https://example.com",
        title: "x".repeat(MAX_SOURCE_TITLE_LENGTH + 1),
      })
    ).rejects.toThrow(/title trop long/);
  });

  it("rawExcerpt au-delà de MAX_SOURCE_EXCERPT_LENGTH → throw", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    await expect(
      addSource(ws.workspaceId, {
        ideaId: idea.id, kind: "url", ref: "https://example.com",
        rawExcerpt: "x".repeat(MAX_SOURCE_EXCERPT_LENGTH + 1),
      })
    ).rejects.toThrow(/rawExcerpt trop long/);
  });
});

describe("sources — cloisonnement workspace", () => {
  it("addSource sur une idée d'un autre workspace → throw", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const ideaB = await createIdea(b.workspaceId, { title: "Idée de B" });

    await expect(
      addSource(a.workspaceId, { ideaId: ideaB.id, kind: "url", ref: "https://x.test" })
    ).rejects.toThrow("idée introuvable dans ce workspace");
  });

  it("une source du workspace A est invisible depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await createIdea(a.workspaceId, { title: "Idée de A" });
    const source = await addSource(a.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://example.com" });

    expect((await listSources(a.workspaceId, {})).map((s) => s.id)).toContain(source.id);
    expect((await listSources(b.workspaceId, {})).map((s) => s.id)).not.toContain(source.id);
    expect(await getSource(b.workspaceId, source.id)).toBeNull();
    expect(await attachExtraction(b.workspaceId, source.id, { extractedText: "vol" })).toBeNull();
    expect(await markSourceFailed(b.workspaceId, source.id, "vol")).toBeNull();
  });
});

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
