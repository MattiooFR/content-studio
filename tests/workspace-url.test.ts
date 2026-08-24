import { describe, expect, it } from "vitest";
import {
  parseWorkspaceState, serializeWorkspaceState, DEFAULT_STATE,
} from "@/lib/workspace-url";

const UUID = "3fb2a102-2bda-4828-9993-6fd5ff3fa9f1";

describe("parseWorkspaceState", () => {
  it("params vides → défauts", () => {
    expect(parseWorkspaceState(new URLSearchParams())).toEqual(DEFAULT_STATE);
  });
  it("valeurs valides", () => {
    const s = parseWorkspaceState(new URLSearchParams(`view=board&bucket=published&item=content:${UUID}`));
    expect(s).toEqual({ view: "board", bucket: "published", item: { type: "content", id: UUID } });
  });
  it("valeurs inconnues → défauts (tolérant, jamais d'exception)", () => {
    const s = parseWorkspaceState(new URLSearchParams("view=nope&bucket=nope&item=nope"));
    expect(s).toEqual(DEFAULT_STATE);
  });
  it("item sans uuid valide → null", () => {
    expect(parseWorkspaceState(new URLSearchParams("item=idea:123")).item).toBeNull();
  });
});

describe("serializeWorkspaceState", () => {
  it("défauts → '/'", () => {
    expect(serializeWorkspaceState(DEFAULT_STATE)).toBe("/");
  });
  it("omet les valeurs par défaut", () => {
    expect(serializeWorkspaceState({ view: "list", bucket: "todo", item: { type: "idea", id: UUID } }))
      .toBe(`/?item=idea%3A${UUID}`);
  });
  it("aller-retour stable", () => {
    const s = { view: "board" as const, bucket: "writing" as const, item: { type: "content" as const, id: UUID } };
    const url = serializeWorkspaceState(s);
    expect(parseWorkspaceState(new URLSearchParams(url.split("?")[1]))).toEqual(s);
  });
});
