import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { ideas } from "@/lib/db/schema";

type IdeaInput = {
  title: string; notes?: string; sourceUrl?: string;
  tags?: string[]; createdBy?: string;
};

export async function listIdeas(workspaceId: string, status?: string) {
  const where = status
    ? and(eq(ideas.workspaceId, workspaceId), eq(ideas.status, status as never))
    : eq(ideas.workspaceId, workspaceId);
  return db.select().from(ideas).where(where).orderBy(desc(ideas.createdAt));
}

export async function getIdea(workspaceId: string, id: string) {
  const [row] = await db.select().from(ideas)
    .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)));
  return row ?? null;
}

export async function createIdea(workspaceId: string, input: IdeaInput) {
  const values: Record<string, unknown> = { workspaceId, title: input.title };
  if (input.notes !== undefined) values.notes = input.notes;
  if (input.sourceUrl !== undefined) values.sourceUrl = input.sourceUrl;
  if (input.tags !== undefined) values.tags = input.tags;
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;
  const [row] = await db.insert(ideas).values(values as any).returning();
  return row;
}

export async function updateIdea(
  workspaceId: string, id: string,
  patch: Partial<IdeaInput> & { status?: "inbox" | "in_progress" | "done" | "archived" }
) {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.sourceUrl !== undefined) update.sourceUrl = patch.sourceUrl;
  if (patch.tags !== undefined) update.tags = patch.tags;
  if (patch.status !== undefined) update.status = patch.status;
  const [row] = await db.update(ideas)
    .set(update as any)
    .where(and(eq(ideas.id, id), eq(ideas.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}
