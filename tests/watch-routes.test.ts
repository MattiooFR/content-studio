import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { signUpTestUser, authedReq, req } from "./helpers";
import { GET as itemsGET } from "@/app/api/watch/items/route";
import { POST as itemsPOST } from "@/app/api/watch/items/[id]/route";
import { GET as summaryGET } from "@/app/api/watch/summary/route";
import { GET as feedsGET, POST as feedsPOST } from "@/app/api/watch/feeds/route";
import { PATCH as feedPATCH, DELETE as feedDELETE } from "@/app/api/watch/feeds/[id]/route";
import { GET as settingsGET, PATCH as settingsPATCH } from "@/app/api/watch/settings/route";
import { upsertWatchItems, listWatchItems, updateWatchSettings } from "@/lib/watch";
import { db } from "@/lib/db";
import { watchItems } from "@/lib/db/schema";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const patchInit = (body: unknown) => ({
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const deleteInit = { method: "DELETE" };
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const item = (over: Record<string, unknown> = {}) => ({
  externalId: "ext-1", status: "proposed" as const,
  textSource: "post source", textAdapted: "adaptation",
  url: "https://exemple.test/p/1",
  ...over,
});

describe("routes /api/watch", () => {
  it("sans session → 401 sur les trois routes", async () => {
    expect((await itemsGET(req("/api/watch/items"))).status).toBe(401);
    expect(
      (await itemsPOST(req("/api/watch/items/x", jsonInit({ action: "refuse" })), params("x"))).status
    ).toBe(401);
    expect((await summaryGET(req("/api/watch/summary"))).status).toBe(401);
  });

  it("GET proposed liste et expire au passage les items de plus de 7 jours", async () => {
    const ws = await signUpTestUser();
    await upsertWatchItems(ws.workspaceId, [
      item({ externalId: "frais" }),
      item({ externalId: "vieux" }),
    ]);
    const huitJours = new Date(Date.now() - 8 * 86_400_000);
    await db.update(watchItems).set({ fetchedAt: huitJours })
      .where(and(eq(watchItems.workspaceId, ws.workspaceId), eq(watchItems.externalId, "vieux")));

    const r = await itemsGET(await authedReq(ws, "/api/watch/items?status=proposed"));
    expect(r.status).toBe(200);
    const { items } = await r.json();
    expect(items.map((i: { externalId: string }) => i.externalId)).toEqual(["frais"]);

    const [vieux] = await listWatchItems(ws.workspaceId, { status: "expired" });
    expect(vieux.externalId).toBe("vieux");
  });

  it("POST refuse pose motif et note", async () => {
    const ws = await signUpTestUser();
    await upsertWatchItems(ws.workspaceId, [item()]);
    const [row] = await listWatchItems(ws.workspaceId, { status: "proposed" });

    const r = await itemsPOST(
      await authedReq(ws, `/api/watch/items/${row.id}`,
        jsonInit({ action: "refuse", reason: "hors_sujet", note: "pas pertinent" })),
      params(row.id)
    );
    expect(r.status).toBe(200);
    const { item: refused } = await r.json();
    expect(refused.status).toBe("refused");
    expect(refused.refusalReason).toBe("hors_sujet");
    expect(refused.refusalNote).toBe("pas pertinent");
  });

  it("POST validate rend ideaId/contentId/jobId une fois le channel réglé", async () => {
    const ws = await signUpTestUser();
    await updateWatchSettings(ws.workspaceId, { channelKey: "x_linkedin" });
    await upsertWatchItems(ws.workspaceId, [item({ textAdapted: "Titre\nsuite" })]);
    const [row] = await listWatchItems(ws.workspaceId, { status: "proposed" });

    const r = await itemsPOST(
      await authedReq(ws, `/api/watch/items/${row.id}`, jsonInit({ action: "validate" })),
      params(row.id)
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.item.status).toBe("validated");
    expect(body.ideaId).toBeTruthy();
    expect(body.contentId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
  });

  it("POST create_idea sur un item pool renvoie item + ideaId", async () => {
    const ws = await signUpTestUser();
    await upsertWatchItems(ws.workspaceId, [item({ status: "pool", textAdapted: undefined })]);
    const [row] = await listWatchItems(ws.workspaceId, { status: "pool" });

    const r = await itemsPOST(
      await authedReq(ws, `/api/watch/items/${row.id}`, jsonInit({ action: "create_idea" })),
      params(row.id)
    );
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ideaId).toBeTruthy();
    expect(body.item.ideaId).toBe(body.ideaId);
  });

  it("POST action inconnue → 400", async () => {
    const ws = await signUpTestUser();
    await upsertWatchItems(ws.workspaceId, [item()]);
    const [row] = await listWatchItems(ws.workspaceId, { status: "proposed" });

    const r = await itemsPOST(
      await authedReq(ws, `/api/watch/items/${row.id}`, jsonInit({ action: "bidule" })),
      params(row.id)
    );
    expect(r.status).toBe(400);
  });

  it("GET summary compte les proposed", async () => {
    const ws = await signUpTestUser();
    await upsertWatchItems(ws.workspaceId, [item({ externalId: "a" }), item({ externalId: "b" })]);

    const r = await summaryGET(await authedReq(ws, "/api/watch/summary"));
    expect(r.status).toBe(200);
    expect((await r.json()).proposed).toBe(2);
  });

  it("isolation : item du workspace A, cookie du workspace B → 404", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    await upsertWatchItems(a.workspaceId, [item()]);
    const [row] = await listWatchItems(a.workspaceId, { status: "proposed" });

    const r = await itemsPOST(
      await authedReq(b, `/api/watch/items/${row.id}`, jsonInit({ action: "refuse" })),
      params(row.id)
    );
    expect(r.status).toBe(404);
  });
});

describe("routes /api/watch/feeds", () => {
  it("sans session → 401 sur GET/POST/PATCH/DELETE", async () => {
    expect((await feedsGET(req("/api/watch/feeds"))).status).toBe(401);
    expect(
      (await feedsPOST(req("/api/watch/feeds", jsonInit({ kind: "account", label: "x" })))).status
    ).toBe(401);
    expect(
      (await feedPATCH(req("/api/watch/feeds/x", patchInit({ enabled: false })), params("x"))).status
    ).toBe(401);
    expect((await feedDELETE(req("/api/watch/feeds/x", deleteInit), params("x"))).status).toBe(401);
  });

  it("POST crée un feed, GET le liste", async () => {
    const ws = await signUpTestUser();
    const r = await feedsPOST(
      await authedReq(ws, "/api/watch/feeds", jsonInit({ kind: "account", label: "@quelquun" }))
    );
    expect(r.status).toBe(200);
    const { feed } = await r.json();
    expect(feed.kind).toBe("account");
    expect(feed.label).toBe("@quelquun");
    expect(feed.enabled).toBe(true);

    const list = await feedsGET(await authedReq(ws, "/api/watch/feeds"));
    const { feeds } = await list.json();
    expect(feeds.map((f: { id: string }) => f.id)).toEqual([feed.id]);
  });

  it("POST même kind+label met à jour la ligne existante (upsert) au lieu d'en créer une seconde", async () => {
    const ws = await signUpTestUser();
    const r1 = await feedsPOST(
      await authedReq(ws, "/api/watch/feeds", jsonInit({ kind: "query", label: "ia générative" }))
    );
    const { feed: f1 } = await r1.json();

    const r2 = await feedsPOST(
      await authedReq(ws, "/api/watch/feeds",
        jsonInit({ kind: "query", label: "ia générative", enabled: false }))
    );
    expect(r2.status).toBe(200);
    const { feed: f2 } = await r2.json();
    expect(f2.id).toBe(f1.id);
    expect(f2.enabled).toBe(false);

    const list = await feedsGET(await authedReq(ws, "/api/watch/feeds"));
    expect((await list.json()).feeds.length).toBe(1);
  });

  it("kind invalide → 400", async () => {
    const ws = await signUpTestUser();
    const r = await feedsPOST(
      await authedReq(ws, "/api/watch/feeds", jsonInit({ kind: "bidule", label: "x" }))
    );
    expect(r.status).toBe(400);
  });

  it("PATCH enabled bascule le feed, DELETE le supprime, DELETE d'un feed déjà supprimé → 404", async () => {
    const ws = await signUpTestUser();
    const created = await feedsPOST(
      await authedReq(ws, "/api/watch/feeds", jsonInit({ kind: "account", label: "@a" }))
    );
    const { feed } = await created.json();

    const patched = await feedPATCH(
      await authedReq(ws, `/api/watch/feeds/${feed.id}`, patchInit({ enabled: false })), params(feed.id)
    );
    expect(patched.status).toBe(200);
    expect((await patched.json()).feed.enabled).toBe(false);

    const deleted = await feedDELETE(
      await authedReq(ws, `/api/watch/feeds/${feed.id}`, deleteInit), params(feed.id)
    );
    expect(deleted.status).toBe(200);

    const again = await feedDELETE(
      await authedReq(ws, `/api/watch/feeds/${feed.id}`, deleteInit), params(feed.id)
    );
    expect(again.status).toBe(404);
  });

  it("isolation : feed du workspace A invisible et non modifiable depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const created = await feedsPOST(
      await authedReq(a, "/api/watch/feeds", jsonInit({ kind: "account", label: "@a" }))
    );
    const { feed } = await created.json();

    const listB = await feedsGET(await authedReq(b, "/api/watch/feeds"));
    expect((await listB.json()).feeds).toEqual([]);

    const patchB = await feedPATCH(
      await authedReq(b, `/api/watch/feeds/${feed.id}`, patchInit({ enabled: false })), params(feed.id)
    );
    expect(patchB.status).toBe(404);

    const deleteB = await feedDELETE(
      await authedReq(b, `/api/watch/feeds/${feed.id}`, deleteInit), params(feed.id)
    );
    expect(deleteB.status).toBe(404);
  });
});

describe("routes /api/watch/settings", () => {
  it("sans session → 401 sur GET/PATCH", async () => {
    expect((await settingsGET(req("/api/watch/settings"))).status).toBe(401);
    expect(
      (await settingsPATCH(req("/api/watch/settings", patchInit({ style: "x" })))).status
    ).toBe(401);
  });

  it("GET rend les settings avec publishConfig redigé", async () => {
    const ws = await signUpTestUser();
    await updateWatchSettings(ws.workspaceId, { publishConfig: { api_key: "sk-abcd1234" } });

    const r = await settingsGET(await authedReq(ws, "/api/watch/settings"));
    expect(r.status).toBe(200);
    const settings = await r.json();
    expect(settings.publishConfig.api_key).toBe("••••1234");
    // Preuve positive : la valeur en clair n'apparaît nulle part dans la
    // réponse sérialisée, pas seulement absente du champ attendu.
    expect(JSON.stringify(settings)).not.toContain("sk-abcd1234");
  });

  it("PATCH accepte l'allow-list et re-redige la réponse — jamais d'écho en clair du body reçu", async () => {
    const ws = await signUpTestUser();
    const r = await settingsPATCH(await authedReq(ws, "/api/watch/settings", patchInit({
      topics: ["ia", "seo"], style: "punchy", requireMedia: true,
      channelKey: "x_linkedin", publishConfig: { api_key: "sk-neuf-1234" },
    })));
    expect(r.status).toBe(200);
    const settings = await r.json();
    expect(settings.topics).toEqual(["ia", "seo"]);
    expect(settings.style).toBe("punchy");
    expect(settings.requireMedia).toBe(true);
    expect(settings.channelKey).toBe("x_linkedin");
    expect(settings.publishConfig.api_key).toBe("••••1234");
    expect(JSON.stringify(settings)).not.toContain("sk-neuf-1234");

    // relecture GET : la valeur stockée reste redigée aussi — jamais
    // retrouvable en clair par un chemin détourné.
    const again = await settingsGET(await authedReq(ws, "/api/watch/settings"));
    expect((await again.json()).publishConfig.api_key).toBe("••••1234");
  });

  it("PATCH channelKey inconnu → 400", async () => {
    const ws = await signUpTestUser();
    const r = await settingsPATCH(
      await authedReq(ws, "/api/watch/settings", patchInit({ channelKey: "nexistepas" }))
    );
    expect(r.status).toBe(400);
  });

  it("isolation : les réglages du workspace A n'affectent pas B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    await updateWatchSettings(a.workspaceId, {
      publishConfig: { api_key: "sk-a-1234" }, style: "a-style",
    });

    const rb = await settingsGET(await authedReq(b, "/api/watch/settings"));
    const settingsB = await rb.json();
    expect(settingsB.style).not.toBe("a-style");
    expect(settingsB.publishConfig).toEqual({});
  });
});
