import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents, contentRevisions, channels, ideas, personas } from "@/lib/db/schema";
import { bus } from "@/lib/events";
import { getLane } from "@/lib/lanes";
import { enqueueSyncIfStale } from "@/lib/publications";

export async function createContentDraft(p: {
  workspaceId: string; ideaId: string; channelKey: string; personaId?: string;
}): Promise<{ contentId: string }> {
  const [idea] = await db.select().from(ideas)
    .where(and(eq(ideas.id, p.ideaId), eq(ideas.workspaceId, p.workspaceId)));
  if (!idea) throw new Error("idée introuvable dans ce workspace");
  const [channel] = await db.select().from(channels)
    .where(and(eq(channels.workspaceId, p.workspaceId), eq(channels.key, p.channelKey)));
  if (!channel) throw new Error(`channel inconnu: ${p.channelKey}`);
  if (p.personaId !== undefined) {
    const [persona] = await db.select().from(personas)
      .where(and(eq(personas.id, p.personaId), eq(personas.workspaceId, p.workspaceId)));
    if (!persona) throw new Error("persona introuvable dans ce workspace");
  }
  const [row] = await db.insert(contents).values({
    workspaceId: p.workspaceId, ideaId: p.ideaId, channelId: channel.id,
    personaId: p.personaId, type: channel.outputType,
  }).returning();
  return { contentId: row.id };
}

export async function applyContentUpdate(p: {
  workspaceId: string; contentId: string; body: string;
  authorType: "agent" | "user"; authorLabel?: string;
  // Écriture faite PENDANT une conversation de lane (Task W11) : quand fourni,
  // le formatage `lane:<id>` PREND LE PAS sur `authorLabel` (source unique du
  // format ici, pas dupliqué côté route PATCH / outil MCP — eux se contentent
  // de transmettre l'id tel quel). C'est ce tag que la page contenu détecte
  // (RevisionsPanel) pour afficher « ouvrir la conversation » sur la révision.
  // Validé contre CE workspace comme tout autre id entrant : un laneId d'un
  // autre workspace (ou inconnu) fait échouer l'écriture plutôt que de poser
  // un tag qui ne mènera jamais à une conversation réelle.
  laneId?: string;
}): Promise<{ revisionId: string; state: "current" | "proposed" }> {
  let authorLabel = p.authorLabel ?? "";
  if (p.laneId !== undefined) {
    const lane = await getLane(p.workspaceId, p.laneId);
    if (!lane) throw new Error("lane introuvable dans ce workspace");
    authorLabel = `lane:${p.laneId}`;
  }

  const result = await db.transaction(async (tx) => {
    const [content] = await tx.select().from(contents)
      .where(and(eq(contents.id, p.contentId), eq(contents.workspaceId, p.workspaceId)))
      .for("update");
    if (!content) throw new Error("content introuvable dans ce workspace");

    const editingActive =
      content.editingUntil != null && content.editingUntil > new Date();
    const proposed = p.authorType === "agent" && editingActive;

    const [rev] = await tx.insert(contentRevisions).values({
      contentId: p.contentId, body: p.body,
      authorType: p.authorType, authorLabel,
      state: proposed ? "proposed" : "current",
    }).returning();

    if (!proposed) {
      if (content.currentRevisionId) {
        await tx.update(contentRevisions).set({ state: "superseded" })
          .where(eq(contentRevisions.id, content.currentRevisionId));
      }
      await tx.update(contents)
        .set({ body: p.body, currentRevisionId: rev.id, updatedAt: new Date() })
        .where(eq(contents.id, p.contentId));
    }
    return { revisionId: rev.id, state: (proposed ? "proposed" : "current") as "current" | "proposed" };
  });
  bus.publish(p.workspaceId, { type: "content.updated", contentId: p.contentId, ...result });
  // Révision devenue courante sur un contenu déjà publié quelque part : job sync
  // (spec §2.3). Jamais pour une proposed — result.state le garantit ici.
  if (result.state === "current") await enqueueSyncIfStale(p.workspaceId, p.contentId, p.body);
  return result;
}

export async function heartbeatEditing(workspaceId: string, contentId: string) {
  await db.update(contents)
    .set({ editingUntil: new Date(Date.now() + 45_000) })
    .where(and(eq(contents.id, contentId), eq(contents.workspaceId, workspaceId)));
}

export async function resolveProposed(p: {
  workspaceId: string; contentId: string; revisionId: string;
  action: "accept" | "reject"; expectedCurrentRevisionId?: string | null;
}): Promise<void> {
  const wasRejected = await db.transaction(async (tx) => {
    const [content] = await tx.select().from(contents)
      .where(and(eq(contents.id, p.contentId), eq(contents.workspaceId, p.workspaceId)))
      .for("update");
    if (!content) throw new Error("content introuvable dans ce workspace");
    const [rev] = await tx.select().from(contentRevisions)
      .where(and(eq(contentRevisions.id, p.revisionId), eq(contentRevisions.contentId, p.contentId)));
    if (!rev || rev.state !== "proposed") throw new Error("révision non proposée");

    if (p.action === "reject") {
      await tx.update(contentRevisions).set({ state: "superseded" })
        .where(eq(contentRevisions.id, rev.id));
      return true;
    }

    if (content.currentRevisionId !== (p.expectedCurrentRevisionId ?? null)) {
      throw new Error("proposition périmée : le contenu a changé depuis");
    }

    if (content.currentRevisionId) {
      await tx.update(contentRevisions).set({ state: "superseded" })
        .where(eq(contentRevisions.id, content.currentRevisionId));
    }
    await tx.update(contentRevisions).set({ state: "current" })
      .where(eq(contentRevisions.id, rev.id));
    // une acceptation clôt la session de proposition : les AUTRES proposeds
    // du même contenu ne doivent pas s'accumuler comme des mines.
    await tx.update(contentRevisions).set({ state: "superseded" })
      .where(and(
        eq(contentRevisions.contentId, p.contentId),
        eq(contentRevisions.state, "proposed"),
      ));
    await tx.update(contents)
      .set({ body: rev.body, currentRevisionId: rev.id, updatedAt: new Date() })
      .where(eq(contents.id, p.contentId));
    return false;
  });
  // reject ne touche jamais la current : aucun événement à publier (v1 actée —
  // les autres onglets la verront disparaître de la liste au prochain load des
  // révisions). Publier ici mentait sur l'état réel : "current" alors que la
  // révision courante du contenu est restée inchangée (celle qui vient d'être
  // superseded par le reject n'est même pas la current).
  if (wasRejected) return;
  bus.publish(p.workspaceId, {
    type: "content.updated", contentId: p.contentId,
    revisionId: p.revisionId, state: "current",
  });
  // Même hook que applyContentUpdate : la proposition acceptée devient le
  // corps courant, donc les publications existantes peuvent être en retard.
  const [fresh] = await db.select({ body: contents.body }).from(contents).where(eq(contents.id, p.contentId));
  if (fresh) await enqueueSyncIfStale(p.workspaceId, p.contentId, fresh.body);
}

export async function setContentStatus(
  workspaceId: string, contentId: string,
  status: "draft" | "review" | "approved" | "published" | "generating" | "rejected"
) {
  const [row] = await db.update(contents).set({ status, updatedAt: new Date() })
    .where(and(eq(contents.id, contentId), eq(contents.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new Error("content introuvable dans ce workspace");
  bus.publish(workspaceId, { type: "content.status", contentId, status });
  return row;
}

export async function getContent(workspaceId: string, contentId: string) {
  const [row] = await db.select({
    content: contents, channel: channels,
  }).from(contents)
    .innerJoin(channels, eq(contents.channelId, channels.id))
    .where(and(eq(contents.id, contentId), eq(contents.workspaceId, workspaceId)));
  return row ? { ...row.content, channel: row.channel } : null;
}

export async function listContents(workspaceId: string, ideaId?: string) {
  const where = ideaId
    ? and(eq(contents.workspaceId, workspaceId), eq(contents.ideaId, ideaId))
    : eq(contents.workspaceId, workspaceId);
  return db.select().from(contents).where(where).orderBy(desc(contents.createdAt));
}

export async function listRevisions(workspaceId: string, contentId: string) {
  const content = await getContent(workspaceId, contentId);
  if (!content) return [];
  return db.select().from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.createdAt));
}
