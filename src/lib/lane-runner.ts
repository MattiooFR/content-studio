import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatLanes, chatMessages } from "@/lib/db/schema";
import { bus, type LaneRunEvent } from "@/lib/events";
import { getLane, getWorkspaceSettings } from "@/lib/lanes";

export type { LaneRunEvent };

export class LaneBusyError extends Error {
  code = "lane_busy" as const;
}

/**
 * Vérification synchrone du verrou, pensée pour la route HTTP : elle doit
 * répondre 409 immédiatement, sans attendre qu'une promesse de run (qui ne
 * se règle qu'à la fin du process CLI, potentiellement longue) rejette.
 * Appelée juste avant `runLaneMessage`, SANS await entre les deux : aucun
 * autre callback ne peut s'intercaler dans cette fenêtre (JS mono-thread),
 * donc la décision reste cohérente avec le verrou que `runLaneMessage`
 * repose (et revérifie) lui-même en tout premier, avant tout await.
 */
export function isLaneBusy(laneId: string): boolean {
  return runningLanes.has(laneId);
}

// ---- verrou : UNE exécution à la fois par lane ---------------------------
// globalThis, comme le bus SSE dans events.ts : next dev recharge les
// modules, ce Set doit survivre au hot-reload — sinon un rechargement
// libérerait silencieusement le verrou pendant qu'un process CLI tourne
// encore, permettant deux `--resume` concurrents sur la même session.
const g = globalThis as unknown as { __csLaneLocks?: Set<string> };
const runningLanes = g.__csLaneLocks ?? new Set<string>();
g.__csLaneLocks = runningLanes;

const STDERR_TAIL_MAX = 500;

type ParseResult = {
  exitCode: number;
  assistantText: string;
  stderrTail: string;
  sessionId: string | null;
};

/**
 * Spawn de la commande CLI configurée par l'utilisateur (workspace_settings
 * .laneCommand), avec le message comme dernier argument positionnel.
 *
 * SÉCURITÉ SPAWN — comment le message ne peut JAMAIS s'échapper de sa
 * position d'argument :
 *
 *   spawn("sh", ["-c", `${laneCommand} "$@"`, "sh", ...args])
 *
 * Le script interprété par `sh -c` est une chaîne FIGÉE : `laneCommand`
 * (choisi par l'utilisateur dans ses réglages) suivi littéralement de
 * `"$@"`. Le message ne fait JAMAIS partie de cette chaîne — il arrive en
 * tant qu'argv séparé (le "sh" après `-c` devient $0 dans le script, args
 * devient $1, $2… ; `"$@"` — entre guillemets — les réinjecte un par un,
 * chacun comme un mot unique, sans re-split ni glob). Le shell ne voit
 * donc jamais le message comme du code à interpréter : un message
 * contenant `"; rm -rf ~"` ou des backticks reste un unique argv, transmis
 * tel quel au process cible, incapable de clore le `"$@"` ou d'ouvrir une
 * nouvelle commande.
 */
function spawnLaneCommand(laneCommand: string, args: string[]) {
  return spawn("sh", ["-c", `${laneCommand} "$@"`, "sh", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Parse le stream-json ligne par ligne. Tolérant : une ligne qui n'est pas
 * du JSON valide (log, warning du CLI…) est simplement ignorée, jamais
 * fatale. Extrait le session_id d'un événement init/system et le texte des
 * événements assistant (accumulé + streamé via onChunk).
 */
function spawnAndParse(
  laneCommand: string,
  args: string[],
  onChunk: (text: string) => void
): Promise<ParseResult> {
  return new Promise((resolve) => {
    const child = spawnLaneCommand(laneCommand, args);

    let assistantText = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let sessionId: string | null = null;
    let settled = false;

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch {
        return; // ligne non-JSON : tolérée, jamais fatale.
      }
      if (typeof json !== "object" || json === null) return;
      const obj = json as Record<string, unknown>;

      if (typeof obj.session_id === "string" && (obj.type === "system" || obj.type === "init")) {
        sessionId = obj.session_id;
      }
      if (obj.type === "assistant") {
        const message = obj.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
        for (const block of blocks) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              assistantText += b.text;
              onChunk(b.text);
            }
          }
        }
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        processLine(stdoutBuffer.slice(0, idx));
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (stdoutBuffer.trim()) processLine(stdoutBuffer); // dernière ligne sans \n final
      resolve({
        exitCode, assistantText,
        stderrTail: stderrBuffer.trim().slice(-STDERR_TAIL_MAX),
        sessionId,
      });
    };

    child.on("close", (code) => finish(code ?? -1));
    child.on("error", (err) => {
      stderrBuffer += err.message;
      finish(-1);
    });
  });
}

/**
 * Lance UN tour de conversation sur une lane : persiste le message user,
 * spawne le CLI configuré (avec --resume si la lane a déjà une session),
 * streame les chunks assistant via onEvent + le bus SSE, puis persiste le
 * résultat (message agent + idle, ou message system + error si le CLI a
 * quitté en erreur — jamais un throw pour ce cas, c'est un résultat
 * normal du run). Ne throw que pour une erreur d'appel : lane introuvable
 * dans ce workspace, ou verrou déjà pris (LaneBusyError → 409 côté route).
 */
export async function runLaneMessage(p: {
  workspaceId: string;
  laneId: string;
  userMessage: string;
  onEvent?: (e: LaneRunEvent) => void;
}): Promise<void> {
  // Verrou AVANT tout await : le corps de la fonction s'exécute de façon
  // synchrone jusqu'ici quel que soit l'appelant (awaited ou non), donc
  // deux appels successifs sur la même lane — même lancés sans attendre le
  // premier — sont sérialisés sans fenêtre de course : le second voit
  // FORCÉMENT le verrou posé par le premier.
  if (runningLanes.has(p.laneId)) {
    throw new LaneBusyError("une exécution est déjà en cours pour cette lane");
  }
  runningLanes.add(p.laneId);

  const emit = (e: LaneRunEvent) => {
    p.onEvent?.(e);
    bus.publish(p.workspaceId, { type: "lane.message", laneId: p.laneId, event: e });
  };

  try {
    const lane = await getLane(p.workspaceId, p.laneId);
    if (!lane) throw new Error("lane introuvable dans ce workspace");

    await db.insert(chatMessages).values({ laneId: lane.id, role: "user", body: p.userMessage });
    await db.update(chatLanes).set({ status: "running" }).where(eq(chatLanes.id, lane.id));

    const settings = await getWorkspaceSettings(p.workspaceId);
    const args = lane.cliSessionId
      ? ["--resume", lane.cliSessionId, p.userMessage]
      : [p.userMessage];

    const result = await spawnAndParse(
      settings.laneCommand,
      args,
      (text) => emit({ type: "chunk", text })
    );

    if (result.sessionId && result.sessionId !== lane.cliSessionId) {
      await db.update(chatLanes).set({ cliSessionId: result.sessionId })
        .where(eq(chatLanes.id, lane.id));
    }

    if (result.exitCode === 0) {
      await db.insert(chatMessages).values({
        laneId: lane.id, role: "agent", body: result.assistantText,
      });
      await db.update(chatLanes).set({ status: "idle" }).where(eq(chatLanes.id, lane.id));
      emit({ type: "done" });
    } else {
      const message = `le CLI a quitté avec le code ${result.exitCode}` +
        (result.stderrTail ? ` : ${result.stderrTail}` : "");
      await db.insert(chatMessages).values({ laneId: lane.id, role: "system", body: message });
      await db.update(chatLanes).set({ status: "error" }).where(eq(chatLanes.id, lane.id));
      emit({ type: "error", message });
    }
  } finally {
    runningLanes.delete(p.laneId);
  }
}
