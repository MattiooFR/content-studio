import { describe, it, expect } from "vitest";
import { signUpTestUser, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { GET as eventsRoute } from "@/app/api/events/route";
import { bus } from "@/lib/events";

describe("GET /api/events — token MCP en Bearer", () => {
  it("401 sans token/invalide ; 200 + flux du workspace du token", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "worker");
    expect((await eventsRoute(req("/api/events"))).status).toBe(401);
    expect((await eventsRoute(req("/api/events", { headers: { authorization: "Bearer cs_deadbeef" } }))).status).toBe(401);

    const res = await eventsRoute(req("/api/events", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toContain("connected");
    // Un événement d'un AUTRE workspace publié juste avant ne doit jamais
    // arriver sur ce flux : seul le marqueur du bon workspace est reçu.
    bus.publish(autre.workspaceId, { type: "idea.created", ideaId: "evt-autre-workspace" });
    bus.publish(ws.workspaceId, { type: "idea.created", ideaId: "evt-du-bon-workspace" });
    const chunk = dec.decode((await reader.read()).value);
    expect(chunk).toContain("evt-du-bon-workspace");
    expect(chunk).not.toContain("evt-autre-workspace");
    await reader.cancel();
  });
});
