import { describe, it, expect } from "vitest";
import { createIdea } from "@/lib/ideas";
import {
  addSource, listSources, getSource, attachExtraction, markSourceFailed,
} from "@/lib/sources";
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
      ideaId: idea.id, kind: "text", ref: "texte brut fourni",
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

  it("kind pdf/audio/video refusés en v1", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "pdf" as never, ref: "storage-key" })
    ).rejects.toThrow("kind non disponible en v1");
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "audio" as never, ref: "storage-key" })
    ).rejects.toThrow("kind non disponible en v1");
    await expect(
      addSource(ws.workspaceId, { ideaId: idea.id, kind: "video" as never, ref: "storage-key" })
    ).rejects.toThrow("kind non disponible en v1");
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
    const source = await addSource(a.workspaceId, { ideaId: idea.id, kind: "text", ref: "texte" });

    expect((await listSources(a.workspaceId, {})).map((s) => s.id)).toContain(source.id);
    expect((await listSources(b.workspaceId, {})).map((s) => s.id)).not.toContain(source.id);
    expect(await getSource(b.workspaceId, source.id)).toBeNull();
    expect(await attachExtraction(b.workspaceId, source.id, { extractedText: "vol" })).toBeNull();
    expect(await markSourceFailed(b.workspaceId, source.id, "vol")).toBeNull();
  });
});
