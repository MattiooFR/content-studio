import { describe, it, expect } from "vitest";
import { createIdea, listIdeas, getIdea } from "@/lib/ideas";
import { createPersona, listPersonas } from "@/lib/personas";
import { signUpTestUser } from "./helpers";

describe("ideas — cloisonnement workspace", () => {
  it("une idée du workspace A est invisible depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await createIdea(a.workspaceId, { title: "Tuto multi-comptes Codex" });

    expect((await listIdeas(a.workspaceId)).map((i) => i.id)).toContain(idea.id);
    expect((await listIdeas(b.workspaceId)).map((i) => i.id)).not.toContain(idea.id);
    expect(await getIdea(b.workspaceId, idea.id)).toBeNull();
  });

  it("personas scopés pareil", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    await createPersona(a.workspaceId, { name: "Mattioo builder" });
    expect((await listPersonas(a.workspaceId)).length).toBe(1);
    expect((await listPersonas(b.workspaceId)).length).toBe(0);
  });

  it("createIdea avec workspaceId en input reste dans A", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await createIdea(a.workspaceId, {
      title: "Test",
      workspaceId: b.workspaceId,
    } as any);

    expect(await getIdea(a.workspaceId, idea.id)).not.toBeNull();
    expect(await getIdea(b.workspaceId, idea.id)).toBeNull();
  });

  it("createPersona avec workspaceId en input reste dans A", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const persona = await createPersona(a.workspaceId, {
      name: "Test",
      workspaceId: b.workspaceId,
    } as any);

    expect((await listPersonas(a.workspaceId)).map((p) => p.id)).toContain(persona.id);
    expect((await listPersonas(b.workspaceId)).map((p) => p.id)).not.toContain(persona.id);
  });
});
