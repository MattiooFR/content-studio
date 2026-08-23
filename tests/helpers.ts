import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { memberships, user as userTable } from "@/lib/db/schema";
import { POST as mcpPOST } from "@/app/api/[transport]/route";

export { db };

export async function tableNames(): Promise<string[]> {
  const rows = await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public'`
  );
  return rows.map((r: Record<string, unknown>) => String(r.table_name));
}

export async function signUpTestUser() {
  const email = `t-${crypto.randomUUID()}@test.local`;
  await auth.api.signUpEmail({
    body: { email, password: "motdepasse-solide-123", name: "Testeur" },
  });
  const [u] = await db.select().from(userTable).where(eq(userTable.email, email));
  const [m] = await db.select().from(memberships).where(eq(memberships.userId, u.id));
  return { userId: u.id, workspaceId: m.workspaceId, email };
}

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
