import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { refuseWatchItem, listWatchItems } from "@/lib/watch";

describe("MCP — veille", () => {
  it("dépose puis liste, scopé au workspace du token ; re-dépôt d'un item décidé → skipped", async () => {
    const u = await signUpTestUser();
    const { token } = await generateMcpToken(u.workspaceId, "test");

    const dep = await callMcpTool(token, "upsert_watch_items", {
      items: [
        { external_id: "e1", status: "proposed", text_source: "src1", text_adapted: "fr1", score: 3 },
        { external_id: "e2", status: "pool", text_source: "src2" },
      ],
    });
    expect(JSON.parse(dep.texte)).toEqual({ written: 2, skipped: 0 });

    const liste = await callMcpTool(token, "list_watch_items", { status: "proposed" });
    const items = JSON.parse(liste.texte);
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe("e1");
    expect(items[0].textAdapted).toBe("fr1");

    // Refus posé via la lib (refuse_watch_item n'est pas un outil de cette
    // tâche) : un item décidé est immuable pour le worker, re-déposer le même
    // external_id doit être ignoré et compté dans skipped.
    const [proposed] = await listWatchItems(u.workspaceId, { status: "proposed" });
    await refuseWatchItem(u.workspaceId, proposed.id, { reason: "hors_sujet" });

    const redep = await callMcpTool(token, "upsert_watch_items", {
      items: [{ external_id: "e1", status: "proposed", text_source: "src1 relu", score: 5 }],
    });
    expect(JSON.parse(redep.texte)).toEqual({ written: 0, skipped: 1 });
  });

  it("statut invalide dans un item → { error }, pas d'exception JSON-RPC", async () => {
    const u = await signUpTestUser();
    const { token } = await generateMcpToken(u.workspaceId, "test");

    const r = await callMcpTool(token, "upsert_watch_items", {
      items: [{ external_id: "bad", status: "validated", text_source: "x" }],
    });
    expect(r.rpc.error).toBeUndefined();
    expect(JSON.parse(r.texte).error).toMatch(/statut invalide/);
  });

  it("upsert_watch_feed + mark_feed_fetched posent feed et date", async () => {
    const u = await signUpTestUser();
    const { token } = await generateMcpToken(u.workspaceId, "test");

    const feed = JSON.parse((await callMcpTool(token, "upsert_watch_feed", {
      kind: "account", label: "@source", params: { lang: "fr" }, enabled: true,
    })).texte);
    expect(feed.label).toBe("@source");
    expect(feed.lastFetchedAt).toBeNull();

    const marked = JSON.parse((await callMcpTool(token, "mark_feed_fetched", { feed_id: feed.id })).texte);
    expect(marked.lastFetchedAt).not.toBeNull();

    const introuvable = JSON.parse((await callMcpTool(token, "mark_feed_fetched", { feed_id: crypto.randomUUID() })).texte);
    expect(introuvable.error).toMatch(/introuvable/);
  });

  it("get_watch_config rend publish_config en clair après update_watch_settings", async () => {
    const u = await signUpTestUser();
    const { token } = await generateMcpToken(u.workspaceId, "test");

    await callMcpTool(token, "update_watch_settings", {
      topics: ["ia", "seo"], style: "punchy", require_media: true,
      channel_key: "community", publish_config: { api_key: "sk-abcdef1234" },
    });

    const cfg = JSON.parse((await callMcpTool(token, "get_watch_config", {})).texte);
    expect(cfg.settings.topics).toEqual(["ia", "seo"]);
    expect(cfg.settings.channelKey).toBe("community");
    expect(cfg.settings.publishConfig).toEqual({ api_key: "sk-abcdef1234" });

    // channel_key inconnu → { error }, réglages inchangés.
    const bad = JSON.parse((await callMcpTool(token, "update_watch_settings", { channel_key: "inconnu" })).texte);
    expect(bad.error).toMatch(/channel inconnu/);
  });

  it("isolation : le token du workspace B ne voit ni items ni config de A", async () => {
    const a = await signUpTestUser();
    const { token: tokenA } = await generateMcpToken(a.workspaceId, "a");
    await callMcpTool(tokenA, "upsert_watch_items", {
      items: [{ external_id: "secretA", status: "pool", text_source: "src" }],
    });
    await callMcpTool(tokenA, "update_watch_settings", { publish_config: { token: "secret-a" } });
    const feedA = JSON.parse((await callMcpTool(tokenA, "upsert_watch_feed", { kind: "account", label: "@a" })).texte);

    const b = await signUpTestUser();
    const { token: tokenB } = await generateMcpToken(b.workspaceId, "b");

    expect(JSON.parse((await callMcpTool(tokenB, "list_watch_items", {})).texte)).toHaveLength(0);

    const cfgB = JSON.parse((await callMcpTool(tokenB, "get_watch_config", {})).texte);
    expect(cfgB.feeds).toHaveLength(0);
    expect(cfgB.settings.publishConfig).toEqual({});

    const markB = JSON.parse((await callMcpTool(tokenB, "mark_feed_fetched", { feed_id: feedA.id })).texte);
    expect(markB.error).toMatch(/introuvable/);
  });
});
