import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
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
  return db
    .select({
      ...getTableColumns(ideas),
      // champ additif (cards de l'inbox) — les colonnes existantes ne bougent pas.
      // Identifiants qualifiés À LA MAIN : en interpolant ${ideas.id}, drizzle
      // émet "id" non qualifié, que Postgres lie à contents.id (portée la plus
      // proche) → compte toujours 0.
      contentsCount: sql<number>`(select count(*)::int from contents c where c.idea_id = ideas.id)`,
      // même pattern, même piège : `s.idea_id = ideas.id` qualifié à la main.
      sourcesCount: sql<number>`(select count(*)::int from sources s where s.idea_id = ideas.id)`,
      // idem : dernier job (tous kinds confondus) visant cette idée, null si aucun.
      lastJobStatus: sql<string | null>`(select j.status from agent_jobs j where j.target_type = 'idea' and j.target_id = ideas.id order by j.created_at desc limit 1)`,
      // agrégat des contenus de l'idée pour la dérivation d'étape côté client
      // (lib stage) — même piège de qualification que ci-dessus : identifiants
      // écrits À LA MAIN, jamais interpolés depuis les objets drizzle.
      contents: sql<{ id: string; status: string; channelKey: string }[]>`(
        select coalesce(json_agg(json_build_object(
          'id', c.id, 'status', c.status, 'channelKey', ch.key
        ) order by c.created_at), '[]'::json)
        from contents c join channels ch on ch.id = c.channel_id
        where c.idea_id = ideas.id
      )`,
    })
    .from(ideas)
    .where(where)
    .orderBy(desc(ideas.createdAt));
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
