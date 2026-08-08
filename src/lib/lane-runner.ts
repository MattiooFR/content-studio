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

// ---- limites de ressources (Fix round 1 — revue adversariale) ------------
// Const plutôt qu'une colonne workspace_settings.laneTimeoutMs : le brief
// autorise explicitement ce choix pour ce tour de fix. Une vraie session
// `claude -p` répond en général en quelques secondes à quelques dizaines de
// secondes ; 2 minutes couvre des tâches plus longues sans laisser un CLI
// planté (ou un `--resume` qui boucle) tourner indéfiniment, verrou posé.
// À faire évoluer vers un réglage par workspace si un besoin réel de
// dépassement apparaît (W11+).
const LANE_TIMEOUT_MS = 120_000;
// Délai de grâce entre SIGTERM et SIGKILL si le process (ou son arbre)
// ignore le premier signal.
const KILL_GRACE_MS = 5_000;
// ~2 MiB — même ordre de grandeur que le plafond anti-DoS de
// fetchGaugeSource (src/lib/gauges.ts) : cohérence de projet sur les
// bornes de flux non fiables.
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

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
 *
 * `detached: true` : le process (et tout ce qu'il fork — un `sh -c`
 * imbriqué, un sous-process du CLI…) devient chef d'un groupe de process
 * À LUI, via setsid(). C'est ce qui permet à `killProcessTree` de cibler
 * TOUT l'arbre d'un coup (pid négatif = groupe entier), pas seulement le
 * process de tête — nécessaire pour le timeout dur et le cap stdout
 * ci-dessous : sans ça, tuer le seul process de tête peut laisser un
 * enfant (ex. un `sleep`, ou tout process que le CLI configuré lance en
 * arrière-plan) orphelin et toujours actif.
 */
function spawnLaneCommand(laneCommand: string, args: string[]) {
  return spawn("sh", ["-c", `${laneCommand} "$@"`, "sh", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

/** Tue TOUT l'arbre de process (groupe entier), avec repli sur le seul enfant. */
function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* déjà mort */ }
  }
}

type TerminationReason = "exit" | "timeout" | "output_cap";

type ParseResult = {
  exitCode: number | null;
  assistantText: string;
  stderrTail: string;
  sessionId: string | null;
  terminationReason: TerminationReason;
  stdoutBytes: number;
};

/**
 * Parse le stream-json ligne par ligne. Tolérant : une ligne qui n'est pas
 * du JSON valide (log, warning du CLI…) est simplement ignorée, jamais
 * fatale. Extrait le session_id d'un événement init/system et le texte des
 * événements assistant (accumulé + streamé via onChunk).
 *
 * Applique aussi les DEUX filets de ressources (Fix round 1) : un timeout
 * dur (`timeoutMs`) et un cap sur le volume de stdout (`MAX_OUTPUT_BYTES`,
 * non paramétrable — c'est une borne anti-DoS, pas un réglage produit).
 * Dépassement de l'un ou l'autre → kill de l'arbre entier (SIGTERM, puis
 * SIGKILL après `killGraceMs` si le process n'a pas encore quitté) ;
 * `terminationReason` distingue la cause pour le message system posé par
 * `runLaneMessage`. `timeoutMs`/`killGraceMs` par défaut aux constantes du
 * module, overridables UNIQUEMENT depuis les tests (fixture FAKE_CLI_HANG) :
 * la route HTTP ne les passe jamais, un run réel utilise toujours les
 * valeurs par défaut.
 *
 * ÉTANCHÉITÉ DU CAP (Fix round 2 — revue adversariale) : franchir
 * MAX_OUTPUT_BYTES ou le timeout ne se contente PAS de demander un kill
 * (qui peut prendre jusqu'à `killGraceMs` si le process ignore SIGTERM,
 * cf. fixture FAKE_CLI_FLOOD qui trap SIGTERM exprès) — `terminate()` coupe
 * IMMÉDIATEMENT la lecture (`stdout.pause()` + retrait du listener `data`),
 * et le handler `data` lui-même vérifie `terminating` en tout premier :
 * un chunk déjà en vol dans la boucle d'événements au moment de la décision
 * est donc ignoré, jamais ajouté à `stdoutBuffer`/`totalBytes`. Sans ce
 * double verrou (flag + arrêt du flux), un CLI qui continue d'écrire
 * pendant toute la fenêtre de grâce ferait grossir `stdoutBuffer` bien
 * au-delà des 2 MiB annoncés — c'est le bug fermé ici (cf.
 * `readBodyCapped` dans `src/lib/gauges.ts`, qui fait déjà `cancel()` +
 * retour immédiat pour la même raison).
 */
function spawnAndParse(
  laneCommand: string,
  args: string[],
  onChunk: (text: string) => void,
  opts: { timeoutMs: number; killGraceMs: number }
): Promise<ParseResult> {
  return new Promise((resolve) => {
    const child = spawnLaneCommand(laneCommand, args);

    let assistantText = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let sessionId: string | null = null;
    let settled = false;
    let terminating = false;
    let reason: TerminationReason = "exit";
    let totalBytes = 0;
    let killGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const clearTimers = () => {
      clearTimeout(hardTimeout);
      clearTimeout(killGraceTimer);
    };

    const terminate = (why: TerminationReason) => {
      if (settled || terminating) return;
      terminating = true;
      reason = why;
      // Coupe la lecture MAINTENANT, avant même d'envoyer le signal : le
      // kill peut prendre jusqu'à killGraceMs (voire ne jamais aboutir sur
      // SIGTERM si le process l'ignore), mais stdoutBuffer ne doit plus
      // grossir d'un octet à partir d'ici. pause() + retrait du listener
      // stoppe le flux au niveau du stream ; le flag `terminating`, vérifié
      // en tête du handler `data`, couvre aussi un chunk déjà en vol dans
      // la boucle d'événements au moment de cet appel.
      child.stdout?.pause();
      child.stdout?.removeAllListeners("data");
      killProcessTree(child, "SIGTERM");
      killGraceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), opts.killGraceMs);
    };

    const hardTimeout = setTimeout(() => terminate("timeout"), opts.timeoutMs);

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
      // Décision de terminer déjà prise (timeout ou cap déjà franchi) :
      // ce chunk était en vol au moment de terminate(), on le jette sans
      // même compter ses octets. C'est CE gate, pas juste le kill, qui
      // borne stdoutBuffer — voir le commentaire sur terminate() ci-dessus.
      if (terminating) return;
      totalBytes += chunk.byteLength;
      stdoutBuffer += chunk.toString("utf8");
      if (totalBytes > MAX_OUTPUT_BYTES) {
        terminate("output_cap");
        return; // lecture coupée : inutile de découper des lignes dans ce dernier chunk.
      }
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) !== -1) {
        processLine(stdoutBuffer.slice(0, idx));
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // dernière ligne sans \n final : seulement si on n'a pas coupé au
      // milieu d'un flux surdimensionné (reason encore "exit" à ce point).
      if (stdoutBuffer.trim() && reason === "exit") processLine(stdoutBuffer);
      resolve({
        exitCode, assistantText,
        stderrTail: stderrBuffer.trim().slice(-STDERR_TAIL_MAX),
        sessionId, terminationReason: reason,
        stdoutBytes: totalBytes,
      });
    };

    child.on("close", (code) => finish(code));
    child.on("error", (err) => {
      stderrBuffer += err.message;
      clearTimers();
      finish(-1);
    });
  });
}

/**
 * Lance UN tour de conversation sur une lane : persiste le message user,
 * spawne le CLI configuré (avec --resume si la lane a déjà une session),
 * streame les chunks assistant via onEvent + le bus SSE, puis persiste le
 * résultat (message agent + idle, ou message system + error si le CLI a
 * quitté en erreur / timeout / dépassement du cap stdout — jamais un throw
 * pour ces cas, ce sont des résultats normaux du run). Ne throw que pour
 * une erreur d'appel : lane introuvable dans ce workspace, ou verrou déjà
 * pris (LaneBusyError → 409 côté route).
 *
 * `timeoutMs`/`killGraceMs` : overrides RÉSERVÉS aux tests (fixture
 * FAKE_CLI_HANG pour vérifier le timeout sans attendre 2 minutes réelles).
 * La route HTTP ne les passe jamais — un run déclenché depuis l'app tourne
 * toujours avec les constantes par défaut du module.
 */
export async function runLaneMessage(p: {
  workspaceId: string;
  laneId: string;
  userMessage: string;
  onEvent?: (e: LaneRunEvent) => void;
  timeoutMs?: number;
  killGraceMs?: number;
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
    // "--" AVANT le message, TOUJOURS : garantit que le message est un
    // argument POSITIONNEL, jamais une option, quel que soit le CLI
    // configuré. Sans lui, un message commençant par "-" (ex.
    // "--dangerously-skip-permissions") serait lu comme un FLAG par le
    // parseur d'arguments du CLI cible (commander.js et consorts) au lieu
    // d'être traité comme du texte — reproduit et confirmé sur le vrai
    // `claude` en revue adversariale (voir task-w10-report.md, Fix round 1).
    const args = lane.cliSessionId
      ? ["--resume", lane.cliSessionId, "--", p.userMessage]
      : ["--", p.userMessage];

    const result = await spawnAndParse(
      settings.laneCommand,
      args,
      (text) => emit({ type: "chunk", text }),
      { timeoutMs: p.timeoutMs ?? LANE_TIMEOUT_MS, killGraceMs: p.killGraceMs ?? KILL_GRACE_MS }
    );

    if (result.sessionId && result.sessionId !== lane.cliSessionId) {
      await db.update(chatLanes).set({ cliSessionId: result.sessionId })
        .where(eq(chatLanes.id, lane.id));
    }

    const ok = result.terminationReason === "exit" && result.exitCode === 0;
    if (ok) {
      await db.insert(chatMessages).values({
        laneId: lane.id, role: "agent", body: result.assistantText,
      });
      await db.update(chatLanes).set({ status: "idle" }).where(eq(chatLanes.id, lane.id));
      emit({ type: "done" });
    } else {
      let message: string;
      if (result.terminationReason === "timeout") {
        message = `interrompu (timeout après ${Math.round((p.timeoutMs ?? LANE_TIMEOUT_MS) / 1000)} s)`;
      } else if (result.terminationReason === "output_cap") {
        // Le compte d'octets reçus est inclus : preuve observable (au-delà
        // du code) que la lecture a bien été coupée au cap, pas seulement
        // qu'un kill a été demandé — voir Fix round 2.
        message = `sortie trop volumineuse, interrompu (${result.stdoutBytes} octets reçus, cap ${MAX_OUTPUT_BYTES})`;
      } else {
        message = `le CLI a quitté avec le code ${result.exitCode}` +
          (result.stderrTail ? ` : ${result.stderrTail}` : "");
      }
      await db.insert(chatMessages).values({ laneId: lane.id, role: "system", body: message });
      await db.update(chatLanes).set({ status: "error" }).where(eq(chatLanes.id, lane.id));
      emit({ type: "error", message });
    }
  } finally {
    // Couvre TOUS les chemins : succès, exit ≠ 0, timeout (kill), cap
    // stdout dépassé (kill), erreur de spawn — spawnAndParse ne résout
    // qu'après le "close" du process (lui-même déclenché par le kill dans
    // les 3 derniers cas), donc ce finally ne s'exécute qu'une fois l'arbre
    // de process réellement terminé. Le verrou ne peut pas rester posé.
    runningLanes.delete(p.laneId);
  }
}
