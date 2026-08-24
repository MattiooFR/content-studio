import { describe, expect, it } from "vitest";
import {
  stageOf, primaryContentOf, countsByBucket, BUCKET_STAGES,
} from "@/lib/stage";

const c = (status: string) => ({ id: `id-${status}`, status, channelKey: "community" });

describe("stageOf", () => {
  it("idée inbox sans contenu → proposed", () => {
    expect(stageOf("inbox", [], null)).toBe("proposed");
  });
  it("idée archivée → discarded, quel que soit le reste", () => {
    expect(stageOf("archived", [c("published")], "running")).toBe("discarded");
  });
  it("tous les contenus rejected (≥1) → discarded", () => {
    expect(stageOf("inbox", [c("rejected")], null)).toBe("discarded");
  });
  it("un rejected parmi d'autres ne suffit pas", () => {
    expect(stageOf("inbox", [c("rejected"), c("review")], null)).toBe("review");
  });
  it("published gagne sur approved/review", () => {
    expect(stageOf("in_progress", [c("draft"), c("published")], null)).toBe("published");
  });
  it("idée done → published même sans contenu", () => {
    expect(stageOf("done", [], null)).toBe("published");
  });
  it("approved → ready", () => {
    expect(stageOf("inbox", [c("approved"), c("draft")], null)).toBe("ready");
  });
  it("review → review", () => {
    expect(stageOf("inbox", [c("review"), c("draft")], null)).toBe("review");
  });
  it("draft/generating → writing", () => {
    expect(stageOf("inbox", [c("draft")], null)).toBe("writing");
    expect(stageOf("inbox", [c("generating")], null)).toBe("writing");
  });
  it("job queued/running → writing même sans contenu", () => {
    expect(stageOf("inbox", [], "queued")).toBe("writing");
    expect(stageOf("inbox", [], "running")).toBe("writing");
  });
  it("job done/failed ne force pas writing", () => {
    expect(stageOf("inbox", [], "done")).toBe("proposed");
    expect(stageOf("inbox", [], "failed")).toBe("proposed");
  });
  it("idée in_progress sans contenu → writing", () => {
    expect(stageOf("in_progress", [], null)).toBe("writing");
  });
});

describe("primaryContentOf", () => {
  it("priorité published > approved > review > generating > draft", () => {
    expect(primaryContentOf([c("draft"), c("review")])?.status).toBe("review");
    expect(primaryContentOf([c("approved"), c("published")])?.status).toBe("published");
  });
  it("vide ou rejected-only → null (fiche idée)", () => {
    expect(primaryContentOf([])).toBeNull();
    expect(primaryContentOf([c("rejected")])).toBeNull();
  });
});

describe("countsByBucket", () => {
  it("compte chaque item dans son bucket, tous les buckets présents", () => {
    const items = [
      { status: "inbox", contents: [], lastJobStatus: null },              // todo (proposed)
      { status: "inbox", contents: [c("review")], lastJobStatus: null },   // todo (review)
      { status: "inbox", contents: [c("draft")], lastJobStatus: null },    // writing
      { status: "done", contents: [c("published")], lastJobStatus: null }, // published
      { status: "archived", contents: [], lastJobStatus: null },           // discarded
    ];
    expect(countsByBucket(items)).toEqual({ todo: 2, writing: 1, published: 1, discarded: 1 });
  });
});

describe("BUCKET_STAGES", () => {
  it("couvre les 6 étapes sans doublon", () => {
    const all = Object.values(BUCKET_STAGES).flat().sort();
    expect(all).toEqual(["discarded", "proposed", "published", "ready", "review", "writing"].sort());
  });
});
