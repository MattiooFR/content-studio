import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { personas } from "@/lib/db/schema";

export async function listPersonas(workspaceId: string) {
  return db.select().from(personas).where(eq(personas.workspaceId, workspaceId));
}

export async function createPersona(
  workspaceId: string,
  input: { name: string; voice?: string; audience?: string; language?: string }
) {
  const values: Record<string, unknown> = { workspaceId, name: input.name };
  if (input.voice !== undefined) values.voice = input.voice;
  if (input.audience !== undefined) values.audience = input.audience;
  if (input.language !== undefined) values.language = input.language;
  const [row] = await db.insert(personas).values(values as any).returning();
  return row;
}
