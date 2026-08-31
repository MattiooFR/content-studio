import { describe, expect, it } from "vitest";
import { signUpTestUser } from "./helpers";
import {
  upsertWatchItems, listWatchItems, countWatchItems,
  MAX_WATCH_BATCH,
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
