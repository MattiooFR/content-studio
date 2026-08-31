import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { watchItems, watchFeeds, watchSettings, channels, ideas } from "@/lib/db/schema";
import { bus } from "@/lib/events";
import { createIdea } from "@/lib/ideas";
import { addSource } from "@/lib/sources";
import { createContentDraft, applyContentUpdate, setContentStatus } from "@/lib/contents";
import { createJob } from "@/lib/jobs";

export type WatchStatus = "pool" | "proposed" | "validated" | "refused" | "expired";
export type WatchItem = typeof watchItems.$inferSelect & { publicationUrl?: string | null };
export type WatchFeed = typeof watchFeeds.$inferSelect;
export type WatchSettings = typeof watchSettings.$inferSelect;

export const MAX_WATCH_BATCH = 200;
export const MAX_WATCH_TEXT_LENGTH = 10_000;
export const MAX_WATCH_EXTERNAL_ID_LENGTH = 200;
export const MAX_WATCH_URL_LENGTH = 2000;
export const MAX_WATCH_JSON_BYTES = 16_384;
export const MAX_WATCH_LIST_LIMIT = 500;
// Proposées par l'UI (boutons de refus) — valeur libre au schéma, jamais
// vérifiée en base : voir refuseWatchItem, « motif libre accepté ».
export const WATCH_REFUSAL_REASONS = ["hors_sujet", "deja_traite", "mauvais_angle", "autre"] as const;
export const MAX_WATCH_NOTE_LENGTH = 280;
export const WATCH_PROPOSED_TTL_MS = 7 * 86_400_000;
export const WATCH_POOL_TTL_MS = 14 * 86_400_000;
// Mêmes bornes que validateHeaders (src/lib/gauges.ts) — publish_config est
// un canal de config libre, mais un objet de chaînes borné comme les headers.
const MAX_PUBLISH_CONFIG_KEYS = 20;
const MAX_PUBLISH_CONFIG_VALUE_LENGTH = 500;
const WATCH_FEED_KINDS = ["account", "query"] as const;
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

export async function refuseWatchItem(
  workspaceId: string, id: string, opts: { reason?: string; note?: string } = {}
): Promise<WatchItem> {
  // Rejeté AVANT toute écriture : un motif hors bornes ne doit jamais poser
  // un decidedAt partiel (même discipline que MAX_WATCH_* au dépôt).
  if (opts.note !== undefined && opts.note.length > MAX_WATCH_NOTE_LENGTH) {
    throw new Error(`note trop longue (max ${MAX_WATCH_NOTE_LENGTH} caractères)`);
  }
  const update: Record<string, unknown> = { status: "refused", decidedAt: new Date() };
  if (opts.reason !== undefined) update.refusalReason = opts.reason;
  if (opts.note !== undefined) update.refusalNote = opts.note;

  const [updated] = await db.update(watchItems).set(update as never)
    .where(and(
      eq(watchItems.workspaceId, workspaceId), eq(watchItems.id, id),
      eq(watchItems.status, "proposed")
    )).returning();
  if (!updated)
    throw new Error("l'item doit être en statut proposed pour être refusé");
  bus.publish(workspaceId, { type: "watch.updated", itemId: id, status: "refused" });
  return updated as WatchItem;
}

export async function validateWatchItem(
  workspaceId: string, id: string, opts: { editedText?: string } = {}
): Promise<{ item: WatchItem; ideaId: string; contentId: string; jobId: string }> {
  return db.transaction(async (tx) => {
    // Verrou consultatif par (workspace, item) tenu jusqu'au commit de CETTE
    // transaction : deux validations concurrentes du même item ne peuvent
    // plus toutes deux lire « proposed » et créer chacune leur idée/contenu/
    // job (double publication — finding de revue). Le verrou ne porte QUE sur
    // `pg_advisory_xact_lock` : la relecture ci-dessous se fait SANS
    // `for("update")` — verrouiller la ligne watch_items elle-même
    // dead-lockerait avec les écritures des libs composées plus bas
    // (createIdea, createContentDraft…), qui passent par le pool `db` global
    // (d'autres connexions) et touchent d'autres tables, jamais watch_items
    // pendant qu'on la tiendrait verrouillée ici.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${workspaceId}:watch-validate:${id}`}))`);

    const [item] = await tx.select().from(watchItems)
      .where(and(eq(watchItems.id, id), eq(watchItems.workspaceId, workspaceId)));
    if (!item) throw new Error("item introuvable dans ce workspace");
    if (item.status !== "proposed") throw new Error(`validation refusée : item en statut ${item.status}`);
    const body = (opts.editedText ?? item.textAdapted ?? "").trim();
    if (!body) throw new Error("aucune adaptation à valider");
    if (body.length > MAX_WATCH_TEXT_LENGTH) throw new Error(`texte trop long (max ${MAX_WATCH_TEXT_LENGTH})`);
    const { settings } = await getWatchConfig(workspaceId);
    if (!settings.channelKey) throw new Error("channel_key manquant dans les réglages veille");

    // Séquence sur les libs existantes (chacune émet ses events — la sidebar
    // suit sans plomberie), volontairement sur `db` (pas `tx`) : elles portent
    // sur d'autres tables et gèrent leurs propres écritures/événements. En
    // cas d'échec après createIdea, OU si l'update final gardé plus bas rend
    // 0 ligne (l'item a changé sous nos pieds — ex. refusé entre-temps, qui
    // ne prend pas ce verrou) : suppression best-effort de l'idée (cascade
    // sur source + contenu), l'item reste proposed — pas d'idée fantôme, pas
    // d'item validé sans contenu.
    const titre = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0)!.slice(0, 120);
    const idea = await createIdea(workspaceId, {
      title: titre, sourceUrl: item.url ?? undefined, createdBy: "watch",
    });
    const cleanupIdea = async () => {
      try {
        await db.delete(ideas)
          .where(and(eq(ideas.id, idea.id), eq(ideas.workspaceId, workspaceId)));
      } catch { /* best-effort : l'échec d'origine prime */ }
    };

    let contentId: string, jobId: string;
    try {
      if (item.url) {
        await addSource(workspaceId, { ideaId: idea.id, kind: "url", ref: item.url, createdBy: "watch" });
      }
      ({ contentId } = await createContentDraft({
        workspaceId, ideaId: idea.id, channelKey: settings.channelKey,
      }));
      await applyContentUpdate({
        workspaceId, contentId, body, authorType: "user", authorLabel: "watch",
      });
      await setContentStatus(workspaceId, contentId, "approved");
      const { job } = await createJob(workspaceId, {
        kind: "publish", targetType: "content", targetId: contentId,
        payload: { watch_item_id: id }, requestedBy: "watch",
      });
      jobId = job.id;
    } catch (e) {
      await cleanupIdea();
      throw e;
    }
    const [updated] = await db.update(watchItems).set({
      status: "validated", textAdapted: body, ideaId: idea.id, contentId, decidedAt: new Date(),
    }).where(and(eq(watchItems.id, id), eq(watchItems.workspaceId, workspaceId), eq(watchItems.status, "proposed")))
      .returning();
    if (!updated) {
      await cleanupIdea();
      throw new Error("l'item a changé pendant la validation");
    }
    bus.publish(workspaceId, { type: "watch.updated", itemId: id, status: "validated" });
    return { item: updated as WatchItem, ideaId: idea.id, contentId, jobId };
  });
}

export async function expireStaleProposed(workspaceId: string): Promise<number> {
  const limit = new Date(Date.now() - WATCH_PROPOSED_TTL_MS).toISOString();
  const rows = await db.update(watchItems)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.status, "proposed"),
      sql`${watchItems.fetchedAt} < ${limit}`)).returning({ id: watchItems.id });
  if (rows.length > 0) bus.publish(workspaceId, { type: "watch.updated" });
  return rows.length;
}

export async function purgeStalePool(workspaceId: string): Promise<number> {
  const limit = new Date(Date.now() - WATCH_POOL_TTL_MS).toISOString();
  const rows = await db.delete(watchItems)
    .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.status, "pool"),
      sql`${watchItems.fetchedAt} < ${limit}`)).returning({ id: watchItems.id });
  return rows.length;
}

/** « Créer une idée » depuis le radar (pool) : idée + source url, item inchangé
 * sinon idea_id posé — l'agent prend le relais par le flux standard (spec §6). */
export async function createIdeaFromPoolItem(
  workspaceId: string, id: string
): Promise<{ ideaId: string }> {
  const [item] = await db.select().from(watchItems)
    .where(and(eq(watchItems.id, id), eq(watchItems.workspaceId, workspaceId)));
  if (!item) throw new Error("item introuvable dans ce workspace");
  if (item.status !== "pool") throw new Error(`création d'idée refusée : item en statut ${item.status}`);
  // Idempotence : un item pool qui a déjà son idée ne doit pas en créer une
  // seconde (double clic sur « Créer une idée » côté radar) — l'UI affichera
  // « Idée créée » plutôt que de rejouer l'action.
  if (item.ideaId) throw new Error("idée déjà créée pour cet item");

  const titre = item.textSource.split("\n").map((l) => l.trim()).find((l) => l.length > 0)?.slice(0, 120)
    ?? item.textSource.slice(0, 120);
  const idea = await createIdea(workspaceId, {
    title: titre, sourceUrl: item.url ?? undefined, createdBy: "watch",
  });
  if (item.url) {
    await addSource(workspaceId, { ideaId: idea.id, kind: "url", ref: item.url, createdBy: "watch" });
  }
  const [updated] = await db.update(watchItems).set({ ideaId: idea.id })
    .where(and(
      eq(watchItems.id, id), eq(watchItems.workspaceId, workspaceId), eq(watchItems.status, "pool"),
    ))
    .returning({ id: watchItems.id });
  if (!updated) throw new Error("item introuvable dans ce workspace");
  bus.publish(workspaceId, { type: "watch.updated", itemId: id });
  return { ideaId: idea.id };
}

/** Crée la ligne de réglages par défaut si absente — même pattern que
 * getWorkspaceSettings (src/lib/lanes.ts) : PK workspace_id, race gérée par
 * onConflictDoNothing + relecture. */
export async function getWatchConfig(
  workspaceId: string
): Promise<{ feeds: WatchFeed[]; settings: WatchSettings }> {
  const feeds = await db.select().from(watchFeeds).where(eq(watchFeeds.workspaceId, workspaceId));

  const [existing] = await db.select().from(watchSettings)
    .where(eq(watchSettings.workspaceId, workspaceId));
  if (existing) return { feeds, settings: existing };

  const [created] = await db.insert(watchSettings)
    .values({ workspaceId })
    .onConflictDoNothing()
    .returning();
  if (created) return { feeds, settings: created };

  // Course rare : un autre appel concurrent a créé la ligne entre le SELECT
  // et l'INSERT ci-dessus — on la relit plutôt que de supposer qu'elle existe.
  const [row] = await db.select().from(watchSettings)
    .where(eq(watchSettings.workspaceId, workspaceId));
  return { feeds, settings: row };
}

/** Valide la FORME d'un patch de publishConfig — pas son résultat final : le
 * nombre de clés est vérifié après merge avec l'existant (voir
 * updateWatchSettings), pas ici sur le patch seul, puisqu'un patch de pure
 * suppression (valeurs `null`) peut légitimement viser plus de
 * MAX_PUBLISH_CONFIG_KEYS clés. `null` est le marqueur de suppression :
 * l'UI write-only ne peut jamais renvoyer une valeur en clair pour une clé
 * qu'elle n'édite pas (masquée côté client, cf. redactPublishConfigForClient)
 * — merger clé par clé est la seule façon de laisser les autres clés
 * survivre à un PATCH partiel. */
function validatePublishConfigPatch(config: unknown): Record<string, string | null> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("publishConfig invalide : objet de chaînes (ou null pour supprimer) attendu");
  }
  const result: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === null) { result[key] = null; continue; }
    if (typeof value !== "string") {
      throw new Error(`publishConfig invalide : la valeur de "${key}" doit être une chaîne ou null`);
    }
    if (value.length > MAX_PUBLISH_CONFIG_VALUE_LENGTH) {
      throw new Error(
        `publishConfig invalide : la valeur de "${key}" dépasse ${MAX_PUBLISH_CONFIG_VALUE_LENGTH} caractères`
      );
    }
    result[key] = value;
  }
  return result;
}

export async function updateWatchSettings(
  workspaceId: string,
  patch: {
    topics?: string[]; style?: string; requireMedia?: boolean;
    channelKey?: string; publishConfig?: Record<string, unknown>;
  }
): Promise<WatchSettings> {
  await getWatchConfig(workspaceId); // garantit que la ligne existe déjà

  if (patch.channelKey !== undefined) {
    const [channel] = await db.select().from(channels)
      .where(and(eq(channels.workspaceId, workspaceId), eq(channels.key, patch.channelKey)));
    if (!channel) throw new Error(`channel inconnu: ${patch.channelKey}`);
  }
  // Forme validée AVANT toute transaction — un patch mal formé ne doit pas
  // en ouvrir une pour rien.
  const publishConfigPatch = patch.publishConfig !== undefined
    ? validatePublishConfigPatch(patch.publishConfig)
    : undefined;

  return db.transaction(async (tx) => {
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.topics !== undefined) update.topics = patch.topics;
    if (patch.style !== undefined) update.style = patch.style;
    if (patch.requireMedia !== undefined) update.requireMedia = patch.requireMedia;
    if (patch.channelKey !== undefined) update.channelKey = patch.channelKey;

    if (publishConfigPatch !== undefined) {
      // Ligne verrouillée le temps de la transaction : deux PATCH publishConfig
      // concurrents ne peuvent pas tous deux merger sur la même base et
      // perdre l'un des deux jeux de clés (write skew classique du
      // read-modify-write).
      const [current] = await tx.select({ publishConfig: watchSettings.publishConfig })
        .from(watchSettings).where(eq(watchSettings.workspaceId, workspaceId)).for("update");
      const merged: Record<string, string> = { ...(current?.publishConfig as Record<string, string> ?? {}) };
      for (const [key, value] of Object.entries(publishConfigPatch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
      }
      if (Object.keys(merged).length > MAX_PUBLISH_CONFIG_KEYS) {
        throw new Error(`publishConfig invalide : ${MAX_PUBLISH_CONFIG_KEYS} clés maximum`);
      }
      update.publishConfig = merged;
    }

    const [row] = await tx.update(watchSettings).set(update as never)
      .where(eq(watchSettings.workspaceId, workspaceId))
      .returning();
    return row as WatchSettings;
  });
}

/** publish_config est write-only côté navigateur (spec §3) — même triptyque de
 * redaction que redactHeadersForClient (src/lib/gauges.ts), sauf qu'ici les 4
 * derniers caractères restent visibles (utile pour distinguer deux secrets). */
export function redactPublishConfigForClient<T extends { publishConfig: unknown }>(
  settings: T
): T & { publishConfig: Record<string, string> } {
  const config = (settings.publishConfig ?? {}) as Record<string, string>;
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    redacted[key] = value.length > 4 ? `••••${value.slice(-4)}` : "••••";
  }
  return { ...settings, publishConfig: redacted };
}

export async function upsertWatchFeed(
  workspaceId: string,
  input: {
    kind: "account" | "query"; label: string;
    params?: Record<string, unknown>; enabled?: boolean;
  }
): Promise<WatchFeed> {
  if (!WATCH_FEED_KINDS.includes(input.kind)) {
    throw new Error("kind invalide (account|query attendu)");
  }
  const label = input.label.trim();
  if (!label) throw new Error("label requis");
  if (input.params !== undefined && Buffer.byteLength(JSON.stringify(input.params), "utf8") > MAX_WATCH_JSON_BYTES) {
    throw new Error(`params trop gros (max ${MAX_WATCH_JSON_BYTES} octets)`);
  }

  const values: Record<string, unknown> = { workspaceId, kind: input.kind, label };
  if (input.params !== undefined) values.params = input.params;
  if (input.enabled !== undefined) values.enabled = input.enabled;
  // `label` réaffecté à sa propre valeur pour que le SET de conflit ne soit
  // jamais vide quand params/enabled sont omis (label fait partie de la clé
  // de conflit — réaffectation neutre).
  const set: Record<string, unknown> = { label };
  if (input.params !== undefined) set.params = input.params;
  if (input.enabled !== undefined) set.enabled = input.enabled;

  const [row] = await db.insert(watchFeeds).values(values as never)
    .onConflictDoUpdate({
      target: [watchFeeds.workspaceId, watchFeeds.kind, watchFeeds.label],
      set,
    }).returning();
  return row as WatchFeed;
}

export async function deleteWatchFeed(workspaceId: string, id: string): Promise<void> {
  const [row] = await db.delete(watchFeeds)
    .where(and(eq(watchFeeds.id, id), eq(watchFeeds.workspaceId, workspaceId)))
    .returning({ id: watchFeeds.id });
  if (!row) throw new Error("feed introuvable dans ce workspace");
}

/** Toggle de PATCH /api/watch/feeds/[id] — même moule que markFeedFetched juste
 * en dessous : update gardé workspaceId+id, throw « introuvable » si 0 ligne. */
export async function setWatchFeedEnabled(
  workspaceId: string, id: string, enabled: boolean
): Promise<WatchFeed> {
  const [row] = await db.update(watchFeeds).set({ enabled })
    .where(and(eq(watchFeeds.id, id), eq(watchFeeds.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new Error("feed introuvable dans ce workspace");
  return row as WatchFeed;
}

export async function markFeedFetched(workspaceId: string, id: string): Promise<WatchFeed> {
  const [row] = await db.update(watchFeeds).set({ lastFetchedAt: new Date() })
    .where(and(eq(watchFeeds.id, id), eq(watchFeeds.workspaceId, workspaceId)))
    .returning();
  if (!row) throw new Error("feed introuvable dans ce workspace");
  return row as WatchFeed;
}
