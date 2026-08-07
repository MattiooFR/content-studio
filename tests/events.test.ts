import { describe, it, expect } from "vitest";
import { bus, type WorkspaceEvent } from "@/lib/events";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/events/route";

describe("bus", () => {
  it("publie vers les abonnés du BON workspace uniquement", () => {
    const seenA: WorkspaceEvent[] = [];
    const seenB: WorkspaceEvent[] = [];
    const unA = bus.subscribe("ws-a", (e) => seenA.push(e));
    const unB = bus.subscribe("ws-b", (e) => seenB.push(e));

    bus.publish("ws-a", { type: "idea.created", ideaId: "i1" });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(0);

    unA();
    bus.publish("ws-a", { type: "idea.created", ideaId: "i2" });
    expect(seenA).toHaveLength(1); // désabonné
    unB();
  });

  it("un handler qui jette ne casse pas les autres", () => {
    const seen: WorkspaceEvent[] = [];
    const un1 = bus.subscribe("ws-c", () => { throw new Error("boom"); });
    const un2 = bus.subscribe("ws-c", (e) => seen.push(e));
    bus.publish("ws-c", { type: "idea.created", ideaId: "i3" });
    expect(seen).toHaveLength(1);
    un1(); un2();
  });
});

describe("GET /api/events", () => {
  it("retourne 401 JSON sans session", async () => {
    const req = new NextRequest("http://localhost:3003/api/events", { method: "GET" });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
  });
});
