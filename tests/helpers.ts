import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { memberships, user as userTable } from "@/lib/db/schema";

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
