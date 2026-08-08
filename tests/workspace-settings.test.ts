import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { GET, PATCH } from "@/app/api/settings/workspace/route";
import { getWorkspaceSettings, DEFAULT_LANE_COMMAND } from "@/lib/lanes";
import { signUpTestUser } from "./helpers";

type TestUser = Awaited<ReturnType<typeof signUpTestUser>>;

// Toutes les autres routes de session du projet (lanes.test.ts, gauges via la
// lib) ne testent QUE le 401 au niveau HTTP et laissent le succès à la lib —
// aucun test existant ne fabrique de session réelle. Ici la route ajoute une
// vraie validation (allow-list, 400) qui vit DANS le handler, pas dans la
// lib : pour la couvrir sans dupliquer un mécanisme de signature de cookie,
// on obtient une session RÉELLE via `signInEmail({ asResponse: true })`, qui
// rend les en-têtes Set-Cookie signés par better-auth lui-même — jamais un
// cookie fabriqué à la main.
async function sessionCookie(user: TestUser): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email: user.email, password: "motdepasse-solide-123" },
    asResponse: true,
  })) as Response;
  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

function req(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost:3003${url}`, init as never);
}

async function authedReq(user: TestUser, url: string, init?: RequestInit) {
  const cookie = await sessionCookie(user);
  return req(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), cookie },
  });
}

describe("routes /api/settings/workspace — session requise", () => {
  it("GET sans session → 401", async () => {
    const res = await GET(req("/api/settings/workspace"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("PATCH sans session → 401", async () => {
    const res = await PATCH(req("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ laneCommand: "claude -p" }),
    }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/settings/workspace", () => {
  it("rend laneCommand par défaut pour un workspace neuf", async () => {
    const ws = await signUpTestUser();
    const res = await GET(await authedReq(ws, "/api/settings/workspace"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.laneCommand).toBe(DEFAULT_LANE_COMMAND);
    expect(body.workspaceId).toBe(ws.workspaceId);
  });
});

describe("PATCH /api/settings/workspace — allow-list stricte", () => {
  it("laneCommand absent → 400, rien n'est écrit", async () => {
    const ws = await signUpTestUser();
    const res = await PATCH(await authedReq(ws, "/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect((await getWorkspaceSettings(ws.workspaceId)).laneCommand).toBe(DEFAULT_LANE_COMMAND);
  });

  it("laneCommand d'un mauvais type → 400", async () => {
    const ws = await signUpTestUser();
    const res = await PATCH(await authedReq(ws, "/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ laneCommand: 42 }),
    }));
    expect(res.status).toBe(400);
  });

  it("laneCommand vide (chaîne blanche) → 400 (setLaneCommand la refuse)", async () => {
    const ws = await signUpTestUser();
    const res = await PATCH(await authedReq(ws, "/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ laneCommand: "   " }),
    }));
    expect(res.status).toBe(400);
  });

  it("laneCommand valide → persisté, cloisonné par workspace", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const res = await PATCH(await authedReq(a, "/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ laneCommand: "codex exec --json" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.laneCommand).toBe("codex exec --json");

    expect((await getWorkspaceSettings(a.workspaceId)).laneCommand).toBe("codex exec --json");
    expect((await getWorkspaceSettings(b.workspaceId)).laneCommand).toBe(DEFAULT_LANE_COMMAND);
  });

  it("un champ hors allow-list (ex. workspaceId) est ignoré, jamais un spread aveugle", async () => {
    const a = await signUpTestUser();
    const res = await PATCH(await authedReq(a, "/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ laneCommand: "claude -p", workspaceId: "evil", extra: "nope" }),
    }));
    expect(res.status).toBe(200);
    const row = await getWorkspaceSettings(a.workspaceId);
    expect(row.workspaceId).toBe(a.workspaceId); // pas écrasé par le "evil" du body
  });
});
