import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents, publications } from "@/lib/db/schema";
import { createJob } from "@/lib/jobs";

export type Publication = typeof publications.$inferSelect;
export const MAX_PUBLICATION_ERROR_LENGTH = 2000;

/** Empreinte du corps markdown tel que publié — la même côté worker (sha256 hex, utf8). */
export function bodyHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function listPublications(workspaceId: string, filter: { target?: string; contentId?: string }) {
  const conds = [eq(publications.workspaceId, workspaceId)];
  if (filter.target) conds.push(eq(publications.target, filter.target));
  if (filter.contentId) conds.push(eq(publications.contentId, filter.contentId));
  return db.select().from(publications).where(and(...conds)).orderBy(desc(publications.createdAt));
}

export async function linkPublication(workspaceId: string, input: {
  contentId: string; target: string; externalId: string; url?: string;
  meta?: Record<string, unknown>; bodyHash: string;
}): Promise<Publication> {
  const [content] = await db.select({ id: contents.id }).from(contents)
    .where(and(eq(contents.id, input.contentId), eq(contents.workspaceId, workspaceId)));
  if (!content) throw new Error("content introuvable dans ce workspace");
  const target = input.target.trim();
  if (!target) throw new Error("target requis");
  if (!input.externalId.trim()) throw new Error("external_id requis");
  const now = new Date();
  const [row] = await db.insert(publications).values({
    workspaceId, contentId: input.contentId, target, externalId: input.externalId,
    url: input.url ?? "", meta: input.meta ?? {}, publishedBodyHash: input.bodyHash,
    publishedAt: now, syncedAt: now, lastError: null,
  }).onConflictDoUpdate({
    target: [publications.contentId, publications.target],
    set: {
      externalId: input.externalId, url: input.url ?? "", meta: input.meta ?? {},
      publishedBodyHash: input.bodyHash, syncedAt: now, lastError: null, updatedAt: now,
    },
  }).returning();
  return row;
}

export async function markSynced(workspaceId: string, publicationId: string, hash: string) {
  const [row] = await db.update(publications)
    .set({ publishedBodyHash: hash, syncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(publications.id, publicationId), eq(publications.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

export async function setPublicationError(workspaceId: string, publicationId: string, error: string) {
  const [row] = await db.update(publications)
    .set({ lastError: error.slice(0, MAX_PUBLICATION_ERROR_LENGTH), updatedAt: new Date() })
    .where(and(eq(publications.id, publicationId), eq(publications.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/**
 * Hook « publié puis modifié » (spec §2.3) : pour chaque publication du contenu
 * dont le hash publié diffère du corps courant, un job `sync` coalescé. Appelé
 * par contents.ts APRÈS qu'une révision est devenue courante — jamais pour une
 * proposed. Idempotent : corps identique au publié → rien.
 */
export async function enqueueSyncIfStale(workspaceId: string, contentId: string, body: string): Promise<number> {
  const pubs = await listPublications(workspaceId, { contentId });
  const hash = bodyHash(body);
  let created = 0;
  for (const p of pubs) {
    if (p.publishedBodyHash === hash) continue;
    const r = await createJob(workspaceId, {
      kind: "sync", targetType: "content", targetId: contentId,
      payload: { publication_id: p.id, target: p.target },
      requestedBy: "system:publication-sync", coalesce: true,
    });
    if (r.created) created++;
  }
  return created;
}
