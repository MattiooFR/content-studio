import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { signUpTestUser, authedReq, req } from "./helpers";
import { GET as itemsGET } from "@/app/api/watch/items/route";
import { POST as itemsPOST } from "@/app/api/watch/items/[id]/route";
import { GET as summaryGET } from "@/app/api/watch/summary/route";
import { upsertWatchItems, listWatchItems, updateWatchSettings } from "@/lib/watch";
import { db } from "@/lib/db";
import { watchItems } from "@/lib/db/schema";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
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
