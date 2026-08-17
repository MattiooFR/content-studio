import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/[transport]/route";
import { generateMcpToken } from "@/lib/tenant";
import { listIdeas } from "@/lib/ideas";
import { signUpTestUser } from "./helpers";

// Appelle un outil MCP à travers le vrai handler HTTP, avec un vrai Bearer :
// c'est le chemin qu'emprunte un agent, auth et cloisonnement compris.
async function appelerOutil(token: string, name: string, args: Record<string, unknown>) {
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
  const res = await POST(req);
  const brut = await res.text();
  // transport streamable : la réponse est du SSE, la charge utile est sur `data:`
  const ligne = brut.split("\n").filter((l) => l.startsWith("data: ")).pop() ?? "";
  const rpc = JSON.parse(ligne.slice("data: ".length));
  return { status: res.status, rpc, texte: rpc.result?.content?.[0]?.text };
}

describe("MCP — create_idea", () => {
  it("dépose une idée dans l'inbox du workspace du token, et la rend", async () => {
    const a = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "test");

    const r = await appelerOutil(token, "create_idea", {
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

    const r = await appelerOutil(token, "create_idea", { title: "Idée de A" });
    const idee = JSON.parse(r.texte);

    expect((await listIdeas(b.workspaceId)).map((i) => i.id)).not.toContain(idee.id);
  });

  it("refuse un titre vide", async () => {
    const a = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "test");

    const r = await appelerOutil(token, "create_idea", { title: "   " });
    // erreur de validation Zod côté MCP : isError sur le résultat, ou erreur JSON-RPC
    const enErreur = r.rpc.error !== undefined || r.rpc.result?.isError === true;
    expect(enErreur).toBe(true);
  });
});
