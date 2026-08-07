import { describe, it, expect } from "vitest";
import path from "node:path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatLanes } from "@/lib/db/schema";
import {
  createLane, listLanes, getLane, getLaneMessages,
  getWorkspaceSettings, setLaneCommand, DEFAULT_LANE_COMMAND,
} from "@/lib/lanes";
import { runLaneMessage, isLaneBusy, LaneBusyError, type LaneRunEvent } from "@/lib/lane-runner";
import { bus, type WorkspaceEvent } from "@/lib/events";
import { signUpTestUser } from "./helpers";
import { GET as lanesGET, POST as lanesPOST } from "@/app/api/lanes/route";
import { GET as messagesGET, POST as messagesPOST } from "@/app/api/lanes/[id]/messages/route";

const FAKE_CLI = path.join(process.cwd(), "tests/fixtures/fake-cli.sh");
const FAKE_CLI_FAIL = `FAKE_CLI_FAIL=1 ${FAKE_CLI}`;

async function fixture(command = FAKE_CLI) {
  const ws = await signUpTestUser();
  await setLaneCommand(ws.workspaceId, command);
  const lane = await createLane(ws.workspaceId, { title: "Conversation test" });
  return { ...ws, lane };
}

describe("createLane / listLanes / getLane", () => {
  it("titre par défaut 'Conversation', status idle, pas de session", async () => {
    const ws = await signUpTestUser();
    const lane = await createLane(ws.workspaceId, {});
    expect(lane.title).toBe("Conversation");
    expect(lane.status).toBe("idle");
    expect(lane.cliSessionId).toBeNull();
  });

  it("titre custom respecté", async () => {
    const ws = await signUpTestUser();
    const lane = await createLane(ws.workspaceId, { title: "Refonte page pricing" });
    expect(lane.title).toBe("Refonte page pricing");
  });

  it("titre vide (chaîne blanche) retombe sur le défaut", async () => {
    const ws = await signUpTestUser();
    const lane = await createLane(ws.workspaceId, { title: "   " });
    expect(lane.title).toBe("Conversation");
  });

  it("cloisonnement : une lane de A est invisible et non lisible depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const lane = await createLane(a.workspaceId, { title: "Lane A" });

    expect((await listLanes(a.workspaceId)).map((l) => l.id)).toContain(lane.id);
    expect((await listLanes(b.workspaceId)).map((l) => l.id)).not.toContain(lane.id);
    expect(await getLane(b.workspaceId, lane.id)).toBeNull();
    expect(await getLaneMessages(b.workspaceId, lane.id)).toBeNull();
  });
});

describe("workspace_settings — laneCommand toujours configurable", () => {
  it("valeur par défaut = commande claude -p documentée", async () => {
    const ws = await signUpTestUser();
    const settings = await getWorkspaceSettings(ws.workspaceId);
    expect(settings.laneCommand).toBe(DEFAULT_LANE_COMMAND);
  });

  it("setLaneCommand persiste un changement, cloisonné par workspace", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    await setLaneCommand(a.workspaceId, FAKE_CLI);

    expect((await getWorkspaceSettings(a.workspaceId)).laneCommand).toBe(FAKE_CLI);
    expect((await getWorkspaceSettings(b.workspaceId)).laneCommand).toBe(DEFAULT_LANE_COMMAND);
  });
});

describe("runLaneMessage — cycle message → chunks → done", () => {
  it("persiste le message user, streame les chunks, persiste le message agent, session_id posé, status idle", async () => {
    const f = await fixture();
    const events: LaneRunEvent[] = [];

    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "Bonjour, présente-toi.",
      onEvent: (e) => events.push(e),
    });

    // au moins les 2 chunks de la fixture + le done, dans l'ordre.
    const chunkTexts = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text);
    expect(chunkTexts.length).toBe(2);
    expect(chunkTexts.join("")).toContain("args-recus:");
    expect(chunkTexts.join("")).toContain("fin-fake-cli");
    expect(events.at(-1)).toEqual({ type: "done" });

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    expect(messages).not.toBeNull();
    expect(messages!.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(messages![0].body).toBe("Bonjour, présente-toi.");
    expect(messages![1].body).toBe(chunkTexts.join(""));

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.cliSessionId).toBe("fake-session-fixed-001");
    expect(lane?.status).toBe("idle");
  });

  it("broadcast : chaque événement arrive aussi sur le bus SSE en lane.message", async () => {
    const f = await fixture();
    const received: WorkspaceEvent[] = [];
    const unsubscribe = bus.subscribe(f.workspaceId, (e) => received.push(e));

    await runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "salut" });
    unsubscribe();

    const laneEvents = received.filter((e) => e.type === "lane.message");
    expect(laneEvents.length).toBeGreaterThanOrEqual(3); // 2 chunks + done
    for (const e of laneEvents) {
      expect((e as { laneId: string }).laneId).toBe(f.lane.id);
    }
    expect(laneEvents.at(-1)).toEqual({
      type: "lane.message", laneId: f.lane.id, event: { type: "done" },
    });
  });

  it("--resume <cliSessionId> transmis au 2e message (prouvé par l'écho de la fixture)", async () => {
    const f = await fixture();

    await runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "premier message" });
    const laneAfterFirst = await getLane(f.workspaceId, f.lane.id);
    expect(laneAfterFirst?.cliSessionId).toBe("fake-session-fixed-001");

    const events: LaneRunEvent[] = [];
    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "deuxieme message",
      onEvent: (e) => events.push(e),
    });

    const text = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text).join("");
    expect(text).toContain("--resume");
    expect(text).toContain("fake-session-fixed-001");
    expect(text).toContain("deuxieme message");
  });

  it("1er message (sans session) : pas de --resume dans les args reçus par le CLI", async () => {
    const f = await fixture();
    const events: LaneRunEvent[] = [];
    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "premier message tout court",
      onEvent: (e) => events.push(e),
    });
    const text = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text).join("");
    expect(text).not.toContain("--resume");
  });
});

describe("runLaneMessage — FAKE_CLI_FAIL : exit ≠ 0", () => {
  it("status error + message system, jamais de throw", async () => {
    const f = await fixture(FAKE_CLI_FAIL);
    const events: LaneRunEvent[] = [];

    await expect(runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "ça va planter",
      onEvent: (e) => events.push(e),
    })).resolves.toBeUndefined();

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as { message: string }).message).toMatch(/code 1/);

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    expect(messages!.map((m) => m.role)).toEqual(["user", "system"]);
    expect(messages![1].body).toMatch(/code 1/);

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.status).toBe("error");
  });
});

describe("runLaneMessage — verrou : une exécution à la fois par lane", () => {
  it("un 2e appel concurrent sur la même lane rejette avec LaneBusyError", async () => {
    const f = await fixture();
    expect(isLaneBusy(f.lane.id)).toBe(false);

    const first = runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "premier" });
    expect(isLaneBusy(f.lane.id)).toBe(true);

    await expect(
      runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "concurrent" })
    ).rejects.toThrow(LaneBusyError);

    await first; // laisse le premier run se terminer proprement
    expect(isLaneBusy(f.lane.id)).toBe(false);
  });

  it("une fois le premier run terminé, un nouveau message passe normalement", async () => {
    const f = await fixture();
    await runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "premier" });
    await expect(
      runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "second, verrou libéré" })
    ).resolves.toBeUndefined();
  });

  it("le verrou est spécifique à la lane : une autre lane n'est jamais bloquée", async () => {
    const f = await fixture();
    const otherLane = await createLane(f.workspaceId, { title: "Autre lane" });

    const first = runLaneMessage({ workspaceId: f.workspaceId, laneId: f.lane.id, userMessage: "premier" });
    await expect(
      runLaneMessage({ workspaceId: f.workspaceId, laneId: otherLane.id, userMessage: "sur une autre lane" })
    ).resolves.toBeUndefined();
    await first;
  });
});

describe("runLaneMessage — cloisonnement", () => {
  it("laneId d'un autre workspace → rejette, verrou libéré, rien persisté", async () => {
    const a = await fixture();
    const b = await signUpTestUser();

    await expect(
      runLaneMessage({ workspaceId: b.workspaceId, laneId: a.lane.id, userMessage: "pirate" })
    ).rejects.toThrow(/introuvable/);

    expect(isLaneBusy(a.lane.id)).toBe(false);
    const messages = await getLaneMessages(a.workspaceId, a.lane.id);
    expect(messages).toEqual([]);
  });

  it("laneId inconnu → rejette de la même façon", async () => {
    const ws = await signUpTestUser();
    await setLaneCommand(ws.workspaceId, FAKE_CLI);
    await expect(
      runLaneMessage({ workspaceId: ws.workspaceId, laneId: crypto.randomUUID(), userMessage: "x" })
    ).rejects.toThrow(/introuvable/);
  });
});

describe("routes /api/lanes — session requise", () => {
  function req(url: string, init?: RequestInit) {
    return new NextRequest(`http://localhost:3003${url}`, init as never);
  }

  it("GET /api/lanes sans session → 401", async () => {
    const res = await lanesGET(req("/api/lanes"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("POST /api/lanes sans session → 401", async () => {
    const res = await lanesPOST(req("/api/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    }));
    expect(res.status).toBe(401);
  });

  it("GET /api/lanes/[id]/messages sans session → 401", async () => {
    const res = await messagesGET(
      req("/api/lanes/00000000-0000-0000-0000-000000000000/messages"),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) }
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/lanes/[id]/messages sans session → 401", async () => {
    const res = await messagesPOST(
      req("/api/lanes/00000000-0000-0000-0000-000000000000/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "salut" }),
      }),
      { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) }
    );
    expect(res.status).toBe(401);
  });
});

describe("schéma — chat_lanes / chat_messages présentes", () => {
  it("une ligne chat_lanes est bien lisible en base brute (colonnes attendues)", async () => {
    const ws = await signUpTestUser();
    const lane = await createLane(ws.workspaceId, {});
    const [row] = await db.select().from(chatLanes).where(eq(chatLanes.id, lane.id));
    expect(row.workspaceId).toBe(ws.workspaceId);
    expect(row.status).toBe("idle");
  });
});
