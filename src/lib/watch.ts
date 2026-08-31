import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { watchItems, watchFeeds, watchSettings, channels, ideas } from "@/lib/db/schema";
import { bus } from "@/lib/events";

export type WatchStatus = "pool" | "proposed" | "validated" | "refused" | "expired";
export type WatchItem = typeof watchItems.$inferSelect & { publicationUrl?: string | null };

export const MAX_WATCH_BATCH = 200;
export const MAX_WATCH_TEXT_LENGTH = 10_000;
export const MAX_WATCH_EXTERNAL_ID_LENGTH = 200;
export const MAX_WATCH_URL_LENGTH = 2000;
export const MAX_WATCH_JSON_BYTES = 16_384;
export const MAX_WATCH_LIST_LIMIT = 500;
const DECIDED: WatchStatus[] = ["validated", "refused", "expired"];

export type WatchItemInput = {
  externalId: string; status: "pool" | "proposed"; textSource: string;
  url?: string; author?: Record<string, unknown>; lang?: string;
  postedAt?: string; metrics?: Record<string, unknown>; media?: unknown[];
  visual?: Record<string, unknown>; textAdapted?: string; score?: number;
};

const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v ?? {}), "utf8");

function validateItem(i: WatchItemInput): void {
  if (i.status !== "pool" && i.status !== "proposed")
    throw new Error("statut invalide au dépôt (pool|proposed attendu)");
  if (!i.externalId?.trim()) throw new Error("externalId requis");
  if (i.externalId.length > MAX_WATCH_EXTERNAL_ID_LENGTH)
    throw new Error(`externalId trop long (max ${MAX_WATCH_EXTERNAL_ID_LENGTH})`);
  if (!i.textSource?.trim()) throw new Error("textSource requis");
  if (i.textSource.length > MAX_WATCH_TEXT_LENGTH)
    throw new Error(`textSource trop long (max ${MAX_WATCH_TEXT_LENGTH})`);
  if (i.textAdapted !== undefined && i.textAdapted.length > MAX_WATCH_TEXT_LENGTH)
    throw new Error(`textAdapted trop long (max ${MAX_WATCH_TEXT_LENGTH})`);
  if (i.url !== undefined && i.url.length > MAX_WATCH_URL_LENGTH)
    throw new Error(`url trop longue (max ${MAX_WATCH_URL_LENGTH})`);
  for (const [nom, val] of [["author", i.author], ["metrics", i.metrics], ["media", i.media], ["visual", i.visual]] as const) {
    if (val !== undefined && jsonBytes(val) > MAX_WATCH_JSON_BYTES)
      throw new Error(`${nom} trop gros (max ${MAX_WATCH_JSON_BYTES} octets)`);
  }
  if (i.postedAt !== undefined && Number.isNaN(Date.parse(i.postedAt)))
    throw new Error("postedAt invalide (ISO 8601 attendu)");
}

export async function upsertWatchItems(
  workspaceId: string, items: WatchItemInput[]
): Promise<{ written: number; skipped: number }> {
  if (items.length > MAX_WATCH_BATCH)
    throw new Error(`lot trop gros (max ${MAX_WATCH_BATCH} items)`);
  for (const i of items) validateItem(i);

  let written = 0, skipped = 0;
  await db.transaction(async (tx) => {
    for (const i of items) {
      // Verrou consultatif par (workspace, external_id) le temps de la transaction :
      // deux upserts simultanés d'un nouvel external_id ne peuvent pas tous deux
      // conclure « n'existe pas » et insérer chacun le leur.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:watch:${i.externalId}`}))`);
      const [existing] = await tx.select().from(watchItems)
        .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.externalId, i.externalId)))
        .for("update");
      // Un item décidé est IMMUABLE pour le worker : un refus d'hier ne peut
      // pas être re-proposé demain (spec §4).
      if (existing && DECIDED.includes(existing.status as WatchStatus)) { skipped++; continue; }

      const commun: Record<string, unknown> = {
        fetchedAt: new Date(),
      };
      if (i.author !== undefined) commun.author = i.author;
      if (i.metrics !== undefined) commun.metrics = i.metrics;
      if (i.media !== undefined) commun.media = i.media;
      if (i.visual !== undefined) commun.visual = i.visual;
      if (i.score !== undefined) commun.score = i.score;

      if (!existing) {
        await tx.insert(watchItems).values({
          workspaceId, externalId: i.externalId, status: i.status,
          textSource: i.textSource, url: i.url, lang: i.lang,
          postedAt: i.postedAt ? new Date(i.postedAt) : undefined,
          textAdapted: i.textAdapted,
          metrics: i.metrics ?? {},
          ...commun,
        } as never);
      } else if (existing.status === "proposed" && i.status === "pool") {
        // jamais de rétrogradation, jamais toucher l'adaptation — seuls les
        // champs d'observation se rafraîchissent.
        await tx.update(watchItems).set(commun as never)
          .where(eq(watchItems.id, existing.id));
      } else {
        await tx.update(watchItems).set({
          status: i.status, textSource: i.textSource, url: i.url, lang: i.lang,
          postedAt: i.postedAt ? new Date(i.postedAt) : existing.postedAt,
          textAdapted: i.textAdapted ?? existing.textAdapted,
          ...commun,
        } as never).where(eq(watchItems.id, existing.id));
      }
      written++;
    }
  });
  if (written > 0) bus.publish(workspaceId, { type: "watch.updated" });
  return { written, skipped };
}

export async function listWatchItems(
  workspaceId: string,
  f: { status?: WatchStatus; since?: Date; limit?: number }
): Promise<WatchItem[]> {
  const limit = Math.min(f.limit ?? 100, MAX_WATCH_LIST_LIMIT);
  const conds = [eq(watchItems.workspaceId, workspaceId)];
  if (f.status) conds.push(eq(watchItems.status, f.status));
  if (f.since) conds.push(sql`${watchItems.fetchedAt} >= ${f.since.toISOString()}`);
  return db.select({
    ...getTableColumns(watchItems),
    // Identifiants qualifiés À LA MAIN (même piège que listIdeas) : le lien de
    // publication d'un item validé, sinon celui porté par l'historique importé.
    publicationUrl: sql<string | null>`coalesce(
      (select p.url from publications p where p.content_id = watch_items.content_id
       order by p.created_at desc limit 1),
      watch_items.publish_ref->>'url')`,
  }).from(watchItems)
    .where(and(...conds))
    .orderBy(sql`watch_items.score desc nulls last`, desc(watchItems.fetchedAt))
    .limit(limit);
}

export async function countWatchItems(workspaceId: string, status: WatchStatus): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(watchItems)
    .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.status, status)));
  return row?.n ?? 0;
}

// Stub minimal : garde status = proposed + update vers refused avec decidedAt.
// La version complète arrive Task 3.
export async function refuseWatchItem(
  workspaceId: string, itemId: string, opts: Record<string, unknown>
): Promise<void> {
  const [updated] = await db.update(watchItems).set({
    status: "refused" as never,
    decidedAt: new Date(),
  }).where(and(
    eq(watchItems.workspaceId, workspaceId), eq(watchItems.id, itemId),
    eq(watchItems.status, "proposed")
  )).returning();
  if (!updated)
    throw new Error("l'item doit être en statut proposed pour être refusé");
}
