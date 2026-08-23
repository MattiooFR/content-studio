import { describe, it, expect } from "vitest";
import { generateMcpToken } from "@/lib/tenant";
import { listIdeas } from "@/lib/ideas";
import { signUpTestUser, callMcpTool } from "./helpers";

describe("MCP — create_idea", () => {
  it("dépose une idée dans l'inbox du workspace du token, et la rend", async () => {
    const a = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "test");

    const r = await callMcpTool(token, "create_idea", {
      title: "Dictée vocale locale sur Mac",
      notes: "pack la-minute-ia",
      source_url: "https://github.com/MattiooFR/dictee",
    });
    expect(r.status).toBe(200);
    const idee = JSON.parse(r.texte);
    expect(idee.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(idee.title).toBe("Dictée vocale locale sur Mac");
    expect(idee.status).toBe("inbox");
    expect(idee.sourceUrl).toBe("https://github.com/MattiooFR/dictee");

    expect((await listIdeas(a.workspaceId)).map((i) => i.id)).toContain(idee.id);
  });

  it("l'idée n'apparaît que dans le workspace du token, jamais ailleurs", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "test");

    const r = await callMcpTool(token, "create_idea", { title: "Idée de A" });
    const idee = JSON.parse(r.texte);

    expect((await listIdeas(b.workspaceId)).map((i) => i.id)).not.toContain(idee.id);
  });

  it("refuse un titre vide", async () => {
    const a = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "test");

    const r = await callMcpTool(token, "create_idea", { title: "   " });
    // erreur de validation Zod côté MCP : isError sur le résultat, ou erreur JSON-RPC
    const enErreur = r.rpc.error !== undefined || r.rpc.result?.isError === true;
    expect(enErreur).toBe(true);
  });
});
