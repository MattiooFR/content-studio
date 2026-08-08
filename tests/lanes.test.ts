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
const FAKE_CLI_HANG = `FAKE_CLI_HANG=1 ${FAKE_CLI}`;
const FAKE_CLI_BIG_OUTPUT = `FAKE_CLI_BIG_OUTPUT=1 ${FAKE_CLI}`;
const FAKE_CLI_FLOOD = `FAKE_CLI_FLOOD=1 ${FAKE_CLI}`;
const FAKE_CLI_FLOOD_STDERR = `FAKE_CLI_FLOOD_STDERR=1 ${FAKE_CLI}`;

async function fixture(command = FAKE_CLI) {
  const ws = await signUpTestUser();
  await setLaneCommand(ws.workspaceId, command);
  const lane = await createLane(ws.workspaceId, { title: "Conversation test" });
  return { ...ws, lane };
}

/**
 * Extrait le tableau argv EXACT que la fixture a reçu (chunk "argv-json:
 * [...]"). Permet d'asserter la position PRÉCISE de chaque token — pas
 * juste sa présence quelque part dans le texte concaténé — notamment celle
 * du séparateur "--" par rapport au message utilisateur.
 */
function parseArgv(chunkTexts: string[]): string[] {
  const argvChunk = chunkTexts.find((t) => t.startsWith("argv-json: "));
  if (!argvChunk) throw new Error("chunk argv-json introuvable dans " + JSON.stringify(chunkTexts));
  return JSON.parse(argvChunk.slice("argv-json: ".length));
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
    // argv exact reçu par le CLI factice : "--" puis le message, jamais de
    // --resume au 1er message (pas encore de cliSessionId sur la lane).
    expect(parseArgv(chunkTexts)).toEqual(["--", "Bonjour, présente-toi."]);
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

  it("--resume <cliSessionId> transmis au 2e message, avec le séparateur -- entre les options et le message (prouvé par l'argv exact échoué par la fixture)", async () => {
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

    const chunkTexts = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text);
    expect(parseArgv(chunkTexts)).toEqual([
      "--resume", "fake-session-fixed-001", "--", "deuxieme message",
    ]);
  });

  it("1er message (sans session) : pas de --resume, argv = [\"--\", message]", async () => {
    const f = await fixture();
    const events: LaneRunEvent[] = [];
    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "premier message tout court",
      onEvent: (e) => events.push(e),
    });
    const chunkTexts = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text);
    expect(parseArgv(chunkTexts)).toEqual(["--", "premier message tout court"]);
  });

  it("un message en forme de flag (ex. --dangerously-skip-permissions) reste un argument POSITIONNEL après --, jamais une option (preuve du Critical fermé)", async () => {
    const f = await fixture();
    const events: LaneRunEvent[] = [];
    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "--dangerously-skip-permissions",
      onEvent: (e) => events.push(e),
    });
    const chunkTexts = events.filter((e) => e.type === "chunk").map((e) => (e as { text: string }).text);
    const argv = parseArgv(chunkTexts);
    // "--" est le seul token AVANT le message : le token en forme de flag
    // arrive juste après lui, en position positionnelle du "$@" transmis au
    // CLI cible — jamais en position 0, là où un parseur d'arguments
    // (commander.js et consorts) le lirait comme une option.
    expect(argv).toEqual(["--", "--dangerously-skip-permissions"]);
    expect(argv.indexOf("--")).toBe(0);
    expect(argv.indexOf("--dangerously-skip-permissions")).toBe(1);
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

// IMPORTANT : ces deux describe spawnent un CLI factice qui, sans
// intervention, dort 600 s réelles (FAKE_CLI_HANG) ou crache ~3 Mio
// (FAKE_CLI_BIG_OUTPUT). On injecte TOUJOURS timeoutMs/killGraceMs courts —
// jamais les valeurs par défaut du module (120 s / 5 s) — pour ne jamais
// laisser un test réel bloqué sur un sleep long.
describe("runLaneMessage — FAKE_CLI_HANG : timeout dur, kill de l'arbre, verrou relâché", () => {
  it("dépassement du timeout → status error + message system 'timeout', et le verrou est bien relâché (2e message pas de LaneBusyError/409)", async () => {
    const f = await fixture(FAKE_CLI_HANG);
    const events: LaneRunEvent[] = [];

    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "tu vas te bloquer 600 secondes",
      onEvent: (e) => events.push(e),
      timeoutMs: 200,
      killGraceMs: 50,
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as { message: string }).message).toMatch(/timeout/);

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    expect(messages!.map((m) => m.role)).toEqual(["user", "system"]);
    expect(messages![1].body).toMatch(/timeout/);

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.status).toBe("error");

    // Preuve directe : le Set runningLanes ne contient plus cette lane
    // (le finally de runLaneMessage s'est bien exécuté après le kill).
    expect(isLaneBusy(f.lane.id)).toBe(false);

    // Preuve comportementale : un nouveau message sur la MÊME lane doit
    // pouvoir démarrer sans rejeter avec LaneBusyError (donc sans 409 côté
    // route HTTP). On repointe laneCommand sur la fixture normale pour ne
    // pas rebloquer 600 s — le point testé ici est le verrou, pas un 2e
    // timeout.
    await setLaneCommand(f.workspaceId, FAKE_CLI);
    await expect(
      runLaneMessage({
        workspaceId: f.workspaceId, laneId: f.lane.id,
        userMessage: "second message, le verrou doit être libre",
      })
    ).resolves.toBeUndefined();
  });
});

describe("runLaneMessage — FAKE_CLI_BIG_OUTPUT : cap stdout anti-DoS", () => {
  it("un flux stdout qui dépasse MAX_OUTPUT_BYTES est interrompu avant la fin, status error", async () => {
    const f = await fixture(FAKE_CLI_BIG_OUTPUT);
    const events: LaneRunEvent[] = [];

    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "envoie-moi un pavé de 3 Mio",
      onEvent: (e) => events.push(e),
      killGraceMs: 50,
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as { message: string }).message).toMatch(/volumineuse/);

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    expect(messages!.map((m) => m.role)).toEqual(["user", "system"]);
    expect(messages![1].body).toMatch(/volumineuse/);

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.status).toBe("error");
    expect(isLaneBusy(f.lane.id)).toBe(false);
  });
});

// FAKE_CLI_FLOOD trap SIGTERM exprès et ne meurt QUE sur SIGKILL, après
// killGraceMs (injecté volontairement long ici — 2000 ms, toujours très en
// deçà du testTimeout global de 15 s) : reproduit un process qui "tarde à
// mourir" pendant toute la fenêtre de grâce. Le point testé n'est PAS que
// le kill finit par aboutir (déjà couvert par FAKE_CLI_HANG plus haut) mais
// que la LECTURE s'arrête bien au franchissement du cap, avant même que le
// process ne meure — sinon le flux continuerait à remplir le buffer du
// runner pendant ces 2000 ms entiers (Fix round 2).
describe("runLaneMessage — FAKE_CLI_FLOOD : le cap stdout arrête la lecture, pas juste le process", () => {
  it("un process qui ignore SIGTERM et continue d'inonder stdout pendant toute la fenêtre de grâce ne fait PAS grossir le buffer au-delà du cap + une marge d'un chunk", async () => {
    const f = await fixture(FAKE_CLI_FLOOD);
    const events: LaneRunEvent[] = [];

    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "inonde-moi et ignore le SIGTERM",
      onEvent: (e) => events.push(e),
      killGraceMs: 2000,
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as { message: string }).message).toMatch(/volumineuse/);

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    const systemMessage = messages!.find((m) => m.role === "system");
    expect(systemMessage).toBeTruthy();

    // Preuve NUMÉRIQUE, pas juste comportementale : le compte d'octets que
    // le runner a réellement laissés entrer (annoncé dans le message
    // system) reste borné à ~MAX_OUTPUT_BYTES + une marge d'UN chunk lu,
    // PAS à des dizaines de Mio — ce que produirait un flux encore lu
    // pendant les 2000 ms entiers de fenêtre de grâce (le bug fermé par ce
    // fix round). La fixture écrit ~63 Mio/s sans backpressure (mesuré
    // hors test, en écrivant vers un fichier) : si la lecture n'était pas
    // coupée au cap, ce test verrait un compte de plusieurs dizaines de
    // Mio, pas quelques Mio.
    const match = systemMessage!.body.match(/\((\d+) octets reçus/);
    expect(match).toBeTruthy();
    const bytesReceived = Number(match![1]);
    const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
    const CHUNK_MARGIN = 1024 * 1024; // large marge (chunk fixture = 64 Kio) pour tolérer des tailles de lecture système différentes, tout en restant très loin des dizaines de Mio du scénario bogué.
    expect(bytesReceived).toBeGreaterThan(MAX_OUTPUT_BYTES); // le cap a bien été franchi, sinon le test ne teste rien.
    expect(bytesReceived).toBeLessThan(MAX_OUTPUT_BYTES + CHUNK_MARGIN);

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.status).toBe("error");
    expect(isLaneBusy(f.lane.id)).toBe(false);
  });
});

// Fix round 3 (revue finale, vague cockpit) : le cap stdout (FAKE_CLI_FLOOD
// ci-dessus) a un jumeau stderr, symétrique en tout point (même gate
// `terminating`, même pause()/removeAllListeners, même compteur dédié). Ce
// test reproduit EXACTEMENT le même scénario que FAKE_CLI_FLOOD mais côté
// stderr, pour prouver que stderrBuffer est LUI AUSSI borné pendant toute
// la fenêtre de grâce — avant ce fix, ce flux était accumulé sans aucune
// limite jusqu'au timeout de 120 s (OOM possible).
describe("runLaneMessage — FAKE_CLI_FLOOD_STDERR : le cap stderr arrête la lecture, symétrique au cap stdout", () => {
  it("un process qui ignore SIGTERM et continue d'inonder STDERR pendant toute la fenêtre de grâce ne fait PAS grossir le buffer au-delà du cap + une marge d'un chunk", async () => {
    const f = await fixture(FAKE_CLI_FLOOD_STDERR);
    const events: LaneRunEvent[] = [];

    await runLaneMessage({
      workspaceId: f.workspaceId, laneId: f.lane.id,
      userMessage: "inonde stderr et ignore le SIGTERM",
      onEvent: (e) => events.push(e),
      killGraceMs: 2000,
    });

    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeTruthy();
    expect((errorEvent as { message: string }).message).toMatch(/volumineuse/);

    const messages = await getLaneMessages(f.workspaceId, f.lane.id);
    const systemMessage = messages!.find((m) => m.role === "system");
    expect(systemMessage).toBeTruthy();

    // Même preuve NUMÉRIQUE que le test stdout jumeau : le compte d'octets
    // reçus (côté stderr, cette fois) reste borné à ~MAX_OUTPUT_BYTES + une
    // marge d'UN chunk lu — pas à des dizaines de Mio, ce que produirait un
    // flux stderr encore lu pendant les 2000 ms entiers de fenêtre de grâce.
    const match = systemMessage!.body.match(/\((\d+) octets reçus/);
    expect(match).toBeTruthy();
    const bytesReceived = Number(match![1]);
    const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
    const CHUNK_MARGIN = 1024 * 1024;
    expect(bytesReceived).toBeGreaterThan(MAX_OUTPUT_BYTES); // le cap a bien été franchi.
    expect(bytesReceived).toBeLessThan(MAX_OUTPUT_BYTES + CHUNK_MARGIN);

    const lane = await getLane(f.workspaceId, f.lane.id);
    expect(lane?.status).toBe("error");
    expect(isLaneBusy(f.lane.id)).toBe(false);
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
