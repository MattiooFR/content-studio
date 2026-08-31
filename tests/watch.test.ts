import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { signUpTestUser } from "./helpers";
import { db } from "@/lib/db";
import { watchItems, watchSettings } from "@/lib/db/schema";
import { listIdeas } from "@/lib/ideas";
import { listSources } from "@/lib/sources";
import { getContent } from "@/lib/contents";
import { listJobs } from "@/lib/jobs";
import {
  upsertWatchItems, listWatchItems, countWatchItems, refuseWatchItem,
  validateWatchItem, expireStaleProposed, purgeStalePool, createIdeaFromPoolItem,
  getWatchConfig, upsertWatchFeed, deleteWatchFeed, markFeedFetched, setWatchFeedEnabled,
  updateWatchSettings, redactPublishConfigForClient,
  MAX_WATCH_BATCH, MAX_WATCH_NOTE_LENGTH,
} from "@/lib/watch";

const item = (over: Record<string, unknown> = {}) => ({
  externalId: "ext-1", status: "proposed" as const,
  textSource: "post source", textAdapted: "adaptation", score: 12.5,
  url: "https://exemple.test/p/1", metrics: { likes: 10, saves: 8 },
  ...over,
});

describe("upsertWatchItems", () => {
  it("insère puis met à jour sur (workspace, external_id)", async () => {
    const u = await signUpTestUser();
    const r1 = await upsertWatchItems(u.workspaceId, [item()]);
    expect(r1).toEqual({ written: 1, skipped: 0 });
    const r2 = await upsertWatchItems(u.workspaceId, [item({ score: 20 })]);
    expect(r2.written).toBe(1);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(row.score).toBe(20);
  });

  it("ne rétrograde jamais proposed → pool mais rafraîchit les métriques", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    await upsertWatchItems(u.workspaceId, [item({ status: "pool", metrics: { likes: 99 }, textAdapted: undefined })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(row.status).toBe("proposed");
    expect((row.metrics as Record<string, unknown>).likes).toBe(99);
    expect(row.textAdapted).toBe("adaptation"); // jamais écrasé par un pool
  });

  it("promeut pool → proposed avec l'adaptation", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item({ status: "pool", textAdapted: undefined })]);
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(row.textAdapted).toBe("adaptation");
  });

  it("ignore silencieusement un item déjà décidé", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const { refuseWatchItem } = await import("@/lib/watch");
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    await refuseWatchItem(u.workspaceId, row.id, {});
    const r = await upsertWatchItems(u.workspaceId, [item({ score: 99 })]);
    expect(r).toEqual({ written: 0, skipped: 1 });
    const [after] = await listWatchItems(u.workspaceId, { status: "refused" });
    expect(after.score).toBe(12.5);
  });

  it("refuse un lot hors bornes (entrée CASSÉE, jamais tronquée)", async () => {
    const u = await signUpTestUser();
    await expect(upsertWatchItems(u.workspaceId,
      Array.from({ length: MAX_WATCH_BATCH + 1 }, (_, i) => item({ externalId: `e${i}` }))
    )).rejects.toThrow(/lot trop gros/);
    await expect(upsertWatchItems(u.workspaceId, [item({ textSource: "x".repeat(10_001) })]))
      .rejects.toThrow(/textSource/);
    await expect(upsertWatchItems(u.workspaceId, [item({ status: "validated" as never })]))
      .rejects.toThrow(/statut/);
  });

  it("cloisonne : le workspace B ne voit rien du workspace A", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    await upsertWatchItems(a.workspaceId, [item()]);
    expect(await listWatchItems(b.workspaceId, {})).toEqual([]);
    expect(await countWatchItems(b.workspaceId, "proposed")).toBe(0);
  });

  it("update sans metrics → les metrics stockées survivent", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item({ metrics: { likes: 10, saves: 8 } })]);
    // Update sans metrics : les métriques doivent survivre
    await upsertWatchItems(u.workspaceId, [item({ score: 20, metrics: undefined })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(row.metrics).toEqual({ likes: 10, saves: 8 });
    expect(row.score).toBe(20);
  });
});

describe("refuseWatchItem", () => {
  it("refuse un item pool → throw, l'item ne bouge pas", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item({ status: "pool" })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "pool" });
    await expect(refuseWatchItem(u.workspaceId, row.id, {}))
      .rejects.toThrow(/proposed/);
    const [after] = await listWatchItems(u.workspaceId, { status: "pool" });
    expect(after.status).toBe("pool");
  });

  it("refuse un item déjà refused → throw", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    await refuseWatchItem(u.workspaceId, row.id, {});
    await expect(refuseWatchItem(u.workspaceId, row.id, {}))
      .rejects.toThrow(/proposed/);
  });

  it("pose motif et note, horodate decided_at", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    const updated = await refuseWatchItem(u.workspaceId, row.id, {
      reason: "hors_sujet", note: "pas notre créneau",
    });
    expect(updated.status).toBe("refused");
    expect(updated.refusalReason).toBe("hors_sujet");
    expect(updated.refusalNote).toBe("pas notre créneau");
    expect(updated.decidedAt).not.toBeNull();
  });

  it("motif libre accepté (pas limité à la constante UI)", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    const updated = await refuseWatchItem(u.workspaceId, row.id, {
      reason: "un motif jamais listé par l'UI",
    });
    expect(updated.refusalReason).toBe("un motif jamais listé par l'UI");
  });

  it("note de plus de 280 caractères → throw", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    await expect(refuseWatchItem(u.workspaceId, row.id, {
      note: "x".repeat(MAX_WATCH_NOTE_LENGTH + 1),
    })).rejects.toThrow(/note/);
    const [after] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(after.status).toBe("proposed"); // rejet AVANT écriture, rien ne bouge
  });
});

describe("validateWatchItem", () => {
  it("valide : idée + source url + contenu approved + job publish ; item → validated", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, { channelKey: "x_linkedin" });
    await upsertWatchItems(u.workspaceId, [item({ textAdapted: "Titre adapté\nsuite du texte" })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });

    const result = await validateWatchItem(u.workspaceId, row.id);
    expect(result.item.status).toBe("validated");
    expect(result.item.ideaId).toBe(result.ideaId);
    expect(result.item.contentId).toBe(result.contentId);
    expect(result.item.decidedAt).not.toBeNull();

    const ideasList = await listIdeas(u.workspaceId);
    expect(ideasList).toHaveLength(1);
    expect(ideasList[0].id).toBe(result.ideaId);
    expect(ideasList[0].sourceUrl).toBe(row.url);

    const srcs = await listSources(u.workspaceId, { ideaId: result.ideaId });
    expect(srcs).toHaveLength(1);
    expect(srcs[0].kind).toBe("url");
    expect(srcs[0].ref).toBe(row.url);

    const content = await getContent(u.workspaceId, result.contentId);
    expect(content?.status).toBe("approved");
    expect(content?.body).toBe("Titre adapté\nsuite du texte");

    const jobs = await listJobs(u.workspaceId, {
      kind: "publish", targetType: "content", targetId: result.contentId,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(result.jobId);
    expect((jobs[0].payload as Record<string, unknown>).watch_item_id).toBe(row.id);
  });

  it("editedText remplace l'adaptation stockée", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, { channelKey: "x_linkedin" });
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });

    const result = await validateWatchItem(u.workspaceId, row.id, { editedText: "texte final édité" });
    expect(result.item.textAdapted).toBe("texte final édité");
    const content = await getContent(u.workspaceId, result.contentId);
    expect(content?.body).toBe("texte final édité");
  });

  it("sans channel_key configuré → throw", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });
    await expect(validateWatchItem(u.workspaceId, row.id)).rejects.toThrow(/channel_key manquant/);
  });

  it("channel_key inconnu → throw, l'item reste proposed, aucune idée ne subsiste", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, { channelKey: "x_linkedin" });
    // Simule une dérive réelle (canal supprimé après coup) plutôt que de passer
    // par updateWatchSettings, qui refuserait lui-même un channelKey inconnu.
    await db.update(watchSettings).set({ channelKey: "inconnu" })
      .where(eq(watchSettings.workspaceId, u.workspaceId));
    await upsertWatchItems(u.workspaceId, [item()]);
    const [row] = await listWatchItems(u.workspaceId, { status: "proposed" });

    await expect(validateWatchItem(u.workspaceId, row.id)).rejects.toThrow(/channel inconnu/);

    const [after] = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(after.status).toBe("proposed");
    expect(after.ideaId).toBeNull();
    expect(await listIdeas(u.workspaceId)).toEqual([]);
  });

  it("item pool → throw", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, { channelKey: "x_linkedin" });
    await upsertWatchItems(u.workspaceId, [item({ status: "pool", textAdapted: undefined })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "pool" });
    await expect(validateWatchItem(u.workspaceId, row.id)).rejects.toThrow(/statut pool/);
  });
});

describe("expireStaleProposed", () => {
  it("bascule les proposed de plus de 7 jours en expired, laisse les frais intacts", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [
      item({ externalId: "vieux" }),
      item({ externalId: "frais" }),
    ]);
    const huitJours = new Date(Date.now() - 8 * 86_400_000);
    await db.update(watchItems).set({ fetchedAt: huitJours })
      .where(and(eq(watchItems.workspaceId, u.workspaceId), eq(watchItems.externalId, "vieux")));

    const n = await expireStaleProposed(u.workspaceId);
    expect(n).toBe(1);

    const [vieux] = await db.select().from(watchItems)
      .where(and(eq(watchItems.workspaceId, u.workspaceId), eq(watchItems.externalId, "vieux")));
    expect(vieux.status).toBe("expired");
    expect(vieux.decidedAt).not.toBeNull();

    const [frais] = await db.select().from(watchItems)
      .where(and(eq(watchItems.workspaceId, u.workspaceId), eq(watchItems.externalId, "frais")));
    expect(frais.status).toBe("proposed");
  });
});

describe("purgeStalePool", () => {
  it("supprime les pool de plus de 14 jours, garde les frais", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [
      item({ externalId: "vieux-pool", status: "pool", textAdapted: undefined }),
      item({ externalId: "frais-pool", status: "pool", textAdapted: undefined }),
    ]);
    const quinzeJours = new Date(Date.now() - 15 * 86_400_000);
    await db.update(watchItems).set({ fetchedAt: quinzeJours })
      .where(and(eq(watchItems.workspaceId, u.workspaceId), eq(watchItems.externalId, "vieux-pool")));

    const n = await purgeStalePool(u.workspaceId);
    expect(n).toBe(1);

    const restants = await listWatchItems(u.workspaceId, { status: "pool" });
    expect(restants.map((r) => r.externalId)).toEqual(["frais-pool"]);
  });
});

describe("createIdeaFromPoolItem", () => {
  it("crée idée + source, l'item garde pool et gagne idea_id", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item({ status: "pool", textAdapted: undefined })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "pool" });

    const { ideaId } = await createIdeaFromPoolItem(u.workspaceId, row.id);

    const ideasList = await listIdeas(u.workspaceId);
    expect(ideasList).toHaveLength(1);
    expect(ideasList[0].id).toBe(ideaId);

    const srcs = await listSources(u.workspaceId, { ideaId });
    expect(srcs).toHaveLength(1);
    expect(srcs[0].ref).toBe(row.url);

    const [after] = await listWatchItems(u.workspaceId, { status: "pool" });
    expect(after.status).toBe("pool");
    expect(after.ideaId).toBe(ideaId);
  });

  it("deuxième appel sur le même item → throw, une seule idée en base (idempotence)", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [item({ status: "pool", textAdapted: undefined })]);
    const [row] = await listWatchItems(u.workspaceId, { status: "pool" });

    await createIdeaFromPoolItem(u.workspaceId, row.id);
    await expect(createIdeaFromPoolItem(u.workspaceId, row.id))
      .rejects.toThrow(/idée déjà créée/);

    const ideasList = await listIdeas(u.workspaceId);
    expect(ideasList).toHaveLength(1);
  });
});

describe("getWatchConfig / updateWatchSettings", () => {
  it("crée la ligne de réglages par défaut", async () => {
    const u = await signUpTestUser();
    const { feeds, settings } = await getWatchConfig(u.workspaceId);
    expect(feeds).toEqual([]);
    expect(settings.workspaceId).toBe(u.workspaceId);
    expect(settings.topics).toEqual([]);
    expect(settings.channelKey).toBeNull();
  });

  it("allow-list : écrit topics/style/requireMedia/channelKey/publishConfig", async () => {
    const u = await signUpTestUser();
    const row = await updateWatchSettings(u.workspaceId, {
      topics: ["seo", "ia"], style: "punchy", requireMedia: true, channelKey: "x_linkedin",
    });
    expect(row.topics).toEqual(["seo", "ia"]);
    expect(row.style).toBe("punchy");
    expect(row.requireMedia).toBe(true);
    expect(row.channelKey).toBe("x_linkedin");
  });

  it("channelKey inexistant → throw", async () => {
    const u = await signUpTestUser();
    await expect(updateWatchSettings(u.workspaceId, { channelKey: "inconnu" }))
      .rejects.toThrow(/channel inconnu/);
  });

  it("publishConfig : valeurs non-string → throw", async () => {
    const u = await signUpTestUser();
    await expect(updateWatchSettings(u.workspaceId, { publishConfig: { limite: 10 as never } }))
      .rejects.toThrow(/chaîne/);
  });

  it("publishConfig : plus de 20 clés → throw", async () => {
    const u = await signUpTestUser();
    const trop = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
    await expect(updateWatchSettings(u.workspaceId, { publishConfig: trop }))
      .rejects.toThrow(/20/);
  });

  it("publishConfig : merge clé par clé — une clé absente du patch survit", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, {
      publishConfig: { api_key: "sk-abcd1234", secret: "xyz" },
    });
    // Le patch ne porte que sur api_key — impossible côté UI write-only de
    // renvoyer `secret` en clair, elle ne doit donc pas disparaître.
    const row = await updateWatchSettings(u.workspaceId, {
      publishConfig: { api_key: "sk-nouveau-9999" },
    });
    expect(row.publishConfig).toEqual({ api_key: "sk-nouveau-9999", secret: "xyz" });
  });

  it("publishConfig : valeur null supprime la clé, les autres survivent", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, {
      publishConfig: { api_key: "sk-abcd1234", secret: "xyz" },
    });
    const row = await updateWatchSettings(u.workspaceId, {
      publishConfig: { secret: null as never },
    });
    expect(row.publishConfig).toEqual({ api_key: "sk-abcd1234" });
  });

  it("publishConfig : plus de 20 clés sur le RÉSULTAT mergé → throw, existant inchangé", async () => {
    const u = await signUpTestUser();
    await updateWatchSettings(u.workspaceId, { publishConfig: { existante: "v" } });
    // 20 clés nouvelles + la clé déjà en place = 21 sur le résultat mergé,
    // alors que le patch lui-même n'en compte que 20.
    const encore = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v"]));
    await expect(updateWatchSettings(u.workspaceId, { publishConfig: encore }))
      .rejects.toThrow(/20/);
    const { settings } = await getWatchConfig(u.workspaceId);
    expect(settings.publishConfig).toEqual({ existante: "v" });
  });
});

describe("redactPublishConfigForClient", () => {
  it("garde les 4 derniers caractères, masque le reste (\"••••\" si ≤ 4)", () => {
    const r = redactPublishConfigForClient({
      publishConfig: { api_key: "sk-abcd1234", court: "abcd" },
    });
    expect(r.publishConfig).toEqual({ api_key: "••••1234", court: "••••" });
  });
});

describe("upsertWatchFeed / markFeedFetched / deleteWatchFeed", () => {
  it("insert puis update sur (kind, label)", async () => {
    const u = await signUpTestUser();
    const created = await upsertWatchFeed(u.workspaceId, { kind: "account", label: "@exemple" });
    expect(created.enabled).toBe(true);

    const updated = await upsertWatchFeed(u.workspaceId, {
      kind: "account", label: "@exemple", params: { lang: "fr" }, enabled: false,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.enabled).toBe(false);
    expect(updated.params).toEqual({ lang: "fr" });

    const { feeds } = await getWatchConfig(u.workspaceId);
    expect(feeds).toHaveLength(1);
  });

  it("markFeedFetched pose la date", async () => {
    const u = await signUpTestUser();
    const feed = await upsertWatchFeed(u.workspaceId, { kind: "query", label: "seo local" });
    expect(feed.lastFetchedAt).toBeNull();
    const updated = await markFeedFetched(u.workspaceId, feed.id);
    expect(updated.lastFetchedAt).not.toBeNull();
  });

  it("deleteWatchFeed supprime ; feed introuvable → throw", async () => {
    const u = await signUpTestUser();
    const feed = await upsertWatchFeed(u.workspaceId, { kind: "account", label: "@autre" });
    await deleteWatchFeed(u.workspaceId, feed.id);
    const { feeds } = await getWatchConfig(u.workspaceId);
    expect(feeds).toEqual([]);
    await expect(deleteWatchFeed(u.workspaceId, feed.id)).rejects.toThrow(/introuvable/);
  });

  it("cloisonne : le workspace B ne voit rien du workspace A", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const feedA = await upsertWatchFeed(a.workspaceId, { kind: "account", label: "@a" });

    const { feeds } = await getWatchConfig(b.workspaceId);
    expect(feeds).toEqual([]);
    await expect(markFeedFetched(b.workspaceId, feedA.id)).rejects.toThrow(/introuvable/);
    await expect(deleteWatchFeed(b.workspaceId, feedA.id)).rejects.toThrow(/introuvable/);
  });

  it("setWatchFeedEnabled bascule enabled ; feed introuvable → throw", async () => {
    const u = await signUpTestUser();
    const feed = await upsertWatchFeed(u.workspaceId, { kind: "account", label: "@toggle" });
    expect(feed.enabled).toBe(true);

    const updated = await setWatchFeedEnabled(u.workspaceId, feed.id, false);
    expect(updated.enabled).toBe(false);

    await expect(
      setWatchFeedEnabled(u.workspaceId, "00000000-0000-0000-0000-000000000000", true)
    ).rejects.toThrow(/introuvable/);
  });

  it("params énorme (> MAX_WATCH_JSON_BYTES) → throw, aucun feed créé", async () => {
    const u = await signUpTestUser();
    const hugeParams = {
      massive: "x".repeat(20_000),
    };
    await expect(upsertWatchFeed(u.workspaceId, {
      kind: "query", label: "huge-feed", params: hugeParams,
    })).rejects.toThrow(/params trop gros/);

    const { feeds } = await getWatchConfig(u.workspaceId);
    expect(feeds).toEqual([]);
  });
});

describe("listWatchItems", () => {
  it("trie par score décroissant, scores null en dernier", async () => {
    const u = await signUpTestUser();
    await upsertWatchItems(u.workspaceId, [
      item({ externalId: "a", score: 1 }),
      item({ externalId: "b", score: 9 }),
      item({ externalId: "c", score: undefined }),
    ]);
    const rows = await listWatchItems(u.workspaceId, { status: "proposed" });
    expect(rows.map((r) => r.externalId)).toEqual(["b", "a", "c"]);
  });
});
