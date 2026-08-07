import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpTokens, memberships } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

export class TenantError extends Error {
  code = "unauthorized" as const;
}

export async function requireWorkspace(
  headers: Headers
): Promise<{ userId: string; workspaceId: string }> {
  const session = await auth.api.getSession({ headers });
  if (!session) throw new TenantError("unauthorized");
  const [m] = await db.select().from(memberships)
    .where(eq(memberships.userId, session.user.id));
  if (!m) throw new TenantError("unauthorized");
  return { userId: session.user.id, workspaceId: m.workspaceId };
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export async function generateMcpToken(workspaceId: string, label: string) {
  const token = `cs_${randomBytes(24).toString("hex")}`;
  const prefix = token.slice(0, 12);
  const [row] = await db.insert(mcpTokens)
    .values({ workspaceId, label, tokenHash: hash(token), prefix })
    .returning();
  return { token, id: row.id, prefix };
}

export async function resolveMcpToken(
  authorizationHeader: string | null
): Promise<{ workspaceId: string } | null> {
  const bearer = authorizationHeader?.match(/^Bearer (cs_[a-f0-9]+)$/)?.[1];
  if (!bearer) return null;
  const [row] = await db.select().from(mcpTokens)
    .where(and(eq(mcpTokens.tokenHash, hash(bearer)), isNull(mcpTokens.revokedAt)));
  if (!row) return null;
  void db.update(mcpTokens).set({ lastUsedAt: new Date() })
    .where(eq(mcpTokens.id, row.id)).then(() => {}, () => {});
  return { workspaceId: row.workspaceId };
}

export async function revokeMcpToken(workspaceId: string, id: string) {
  await db.update(mcpTokens).set({ revokedAt: new Date() })
    .where(and(eq(mcpTokens.id, id), eq(mcpTokens.workspaceId, workspaceId)));
}
