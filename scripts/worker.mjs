#!/usr/bin/env node
// scripts/worker.mjs — LE worker local de content-studio.
//
// Tourne sur le Mac (là où vivent yt-dlp, ffmpeg et mlx-whisper) et parle
// EXCLUSIVEMENT MCP à content-studio, comme n'importe quel worker — jamais
// la base en direct.
//
//   CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… \
//     node scripts/worker.mjs [--once]
//
// kinds pris en charge :
//   extract     (cible source)  url → fetch + Readability ; video → yt-dlp + mlx_whisper CLI
//   transcribe  (cible comment OU dictation) audio → ffmpeg → mlx-whisper RÉSIDENT → complete_job({ text })
//
// Temps réel : le worker s'abonne à /api/events (Bearer) et traite un job
// queued dès son apparition ; le poll toutes les 15 s reste le filet.
// Tout échec → fail_job(message lisible) ; la cible passe failed côté outil.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_URL = process.env.CS_MCP_URL;
const MCP_TOKEN = process.env.CS_MCP_TOKEN;
const WHISPER_MODEL = process.env.CS_WHISPER_MODEL ?? "mlx-community/whisper-large-v3-turbo";
const PYTHON = process.env.CS_PYTHON ?? `${process.env.HOME}/.claude/tools/yt-transcript/venv/bin/python`;
const ONCE = process.argv.includes("--once");
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000; // le serveur bascule un running en failed après 10 min de silence
const MODEL_IDLE_MS = 15 * 60_000; // modèle déchargé après 15 min sans dictée (~0,9 Go de RAM)
const PY_TIMEOUT_MS = 10 * 60_000; // borne dure autour d'un appel transcribeWav — généreux pour le tout premier téléchargement du modèle
const KINDS = new Set(["extract", "transcribe"]);
const WORKER_LABEL = `worker@${hostname()}`;

if (!MCP_URL || !MCP_TOKEN) {
  console.error("CS_MCP_URL et CS_MCP_TOKEN requis (token workspace : UI → Réglages → Tokens MCP)");
  process.exit(1);
}
const BASE = MCP_URL.replace(/\/api\/mcp\/?$/, "");
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

let client;
async function connect() {
  client = new Client({ name: "content-studio-worker", version: "2.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
}

// Appel d'outil + décodage du JSON métier. Une erreur métier ({ error }) est
// convertie en exception : chaque appelant décide (claim perdu = on passe).
// Piège : claim_job/complete_job/fail_job rendent la LIGNE du job, qui porte
// sa propre colonne `error` (null, ou le message d'un échec passé) — seule
// une réponse SANS `id` est une erreur métier, jamais une ligne rendue.
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const data = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (data && typeof data === "object" && !Array.isArray(data)
    && "error" in data && !("id" in data)) {
    throw new Error(`${name}: ${data.error}`);
  }
  return data;
}

// ---- extracteurs (kind extract) — INCHANGÉS, repris de extract-worker.mjs ----
// Hôtes interdits : le worker tourne sur le Mac du propriétaire — ne jamais
// aspirer le LAN pour le compte d'un membre du workspace. DNS-rebinding hors
// périmètre (outil personnel) : on filtre schéma, hôtes et IP littérales,
// pas la résolution DNS — risque résiduel accepté.
function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("ref doit être une URL http(s)"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("ref doit être une URL http(s)");
  const host = u.hostname.toLowerCase();
  const prive =
    host === "localhost" || host.endsWith(".local") || host === "0.0.0.0" ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    host === "[::1]" || host === "[::]" ||
    host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd");
  if (prive) throw new Error(`hôte privé ou local refusé (${host})`);
  return u;
}

async function extractUrl(ref) {
  let url = assertPublicHttpUrl(ref);
  let res;
  // Redirections À LA MAIN : un 302 vers http://192.168.1.1 ne doit jamais être suivi.
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirection ${res.status} sans Location`);
      url = assertPublicHttpUrl(new URL(location, url).href);
      continue;
    }
    break;
  }
  if (res.status >= 300 && res.status < 400) throw new Error("trop de redirections (max 5)");
  if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("html")) {
    throw new Error(`contenu non HTML (${type.split(";")[0] || "type inconnu"}) — déposer le texte à la main`);
  }
  // res.text() décoderait en UTF-8 aveugle : une page dont le charset n'est
  // déclaré que dans <meta> (windows-1252, iso-8859-1…) sortirait avec les
  // accents cassés. On lit les octets et on décode selon l'en-tête, sinon le
  // <meta> des 2 premiers Ko, sinon UTF-8.
  const bytes = new Uint8Array(await res.arrayBuffer());
  let charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  let html;
  try {
    html = new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes); // charset exotique : repli UTF-8
  }
  const { document } = parseHTML(html);
  const article = new Readability(document).parse();
  if (!article || !article.textContent?.trim()) {
    throw new Error("Readability n'a rien extrait de cette page");
  }
  return {
    text: article.textContent.trim(),
    meta: {
      title: article.title || undefined,
      byline: article.byline || undefined,
      site: article.siteName || undefined,
      lang: article.lang || undefined,
      tool: "extract-worker/readability",
    },
  };
}

async function extractVideo(ref) {
  if (!/^https?:\/\//i.test(ref)) throw new Error("ref doit être une URL http(s)");
  const dir = await mkdtemp(join(tmpdir(), "cs-extract-"));
  try {
    // -j --no-simulate : télécharge ET rend les métadonnées JSON sur stdout.
    const { stdout } = await run(
      "yt-dlp",
      ["--no-playlist", "-x", "--audio-format", "m4a",
        "-o", join(dir, "audio.%(ext)s"), "-j", "--no-simulate", "--", ref],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout);
    await run(
      "mlx_whisper",
      [join(dir, "audio.m4a"), "--model", WHISPER_MODEL,
        "--output-format", "txt", "--output-dir", dir],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const text = (await readFile(join(dir, "audio.txt"), "utf8")).trim();
    if (!text) throw new Error("transcript vide (mlx_whisper n'a rien produit)");
    return {
      text,
      meta: {
        title: typeof info.title === "string" ? info.title : undefined,
        duration_s: typeof info.duration === "number" ? info.duration : undefined,
        model: WHISPER_MODEL,
        tool: "extract-worker/yt-dlp+mlx-whisper",
      },
    };
  } catch (e) {
    // Binaire absent (ENOENT) : message actionnable plutôt qu'un spawn error.
    if (e?.code === "ENOENT") throw new Error(`binaire manquant : ${e.path ?? "yt-dlp/mlx_whisper"} (PATH du worker)`);
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- transcripteur résident (kind transcribe) ------------------------------
// Le modèle pèse ~0,9 Go : il démarre à la première dictée, reste chargé
// tant que ça dicte, et s'efface après MODEL_IDLE_MS sans travail.
let py = null, pyReady = false, waiting = [], idleTimer = null, stopping = false;

function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (py && !waiting.length) {
      log("modèle déchargé (inactivité)");
      stopping = true;
      py.stdin.end();
      // Respawn immédiat autorisé : la garde `py !== child` de `reset` rend
      // inoffensif l'`exit` qui arrivera plus tard pour CE process — une
      // dictée qui arrive dans la fenêtre (avant que le process ait fini de
      // sortir) relance ensurePython() au lieu d'échouer sur un stdin fermé.
      py = null; pyReady = false;
    }
  }, MODEL_IDLE_MS);
}

function ensurePython() {
  if (py) return;
  stopping = false;
  log("chargement du modèle mlx-whisper…");
  const child = spawn(PYTHON, [join(HERE, "transcribe-worker.py")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CS_WHISPER_MODEL: WHISPER_MODEL },
  });
  py = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { pyReady = true; log("modèle chargé — prêt à transcrire"); continue; }
      const resolve = waiting.shift();
      if (resolve) resolve(msg);
      if (!waiting.length) armIdle();
    }
  });
  // Remise à zéro partagée par error/exit/close : idempotente (si un nouveau child a déjà
  // pris le relais, `py !== child` et on ne touche à rien) — un spawn ENOENT n'émet parfois
  // QUE 'error' (jamais 'exit'), sinon ensurePython() ne relancerait plus jamais rien.
  const reset = (message) => {
    if (py !== child) return;
    py = null; pyReady = false;
    waiting.forEach((r) => r({ error: message })); waiting = [];
  };
  child.on("error", (e) => {
    // ENOENT = python du venv introuvable : les dictées en attente échouent proprement
    const message = e?.code === "ENOENT" ? `python introuvable : ${PYTHON} (CS_PYTHON)` : e.message;
    reset(message);
  });
  child.on("exit", (code) => {
    if (!stopping) log(`transcripteur arrêté (code ${code}) — il repartira à la prochaine dictée`);
    reset("transcripteur arrêté");
  });
  // Belt-and-braces : rattrape les cas où 'exit' ne serait jamais émis après un 'error' de spawn.
  child.on("close", () => reset("transcripteur arrêté"));
}

// Sans borne, un Python qui pend (téléchargement du modèle calé, GPU figé)
// bloquerait processJob pour toujours — le heartbeat maintient le job
// running, rien ne le fait jamais échouer. PY_TIMEOUT_MS borne l'attente ;
// à expiration on tue le transcripteur (→ exit → reset() résout les
// attentes restantes en { error }) et on rend une erreur explicite pour
// CET appel, nettoyée du minuteur dès que la promesse se résout (normalement
// ou par timeout) pour ne rien laisser tourner en trop.
function transcribeWav(wav) {
  ensurePython();
  clearTimeout(idleTimer);
  if (!py || py.stdin.destroyed || !py.stdin.writable) {
    return Promise.resolve({ error: "transcripteur indisponible (python introuvable ou arrêté)" });
  }
  const result = new Promise((resolve) => { waiting.push(resolve); py.stdin.write(wav + "\n"); });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      log(`transcription > ${Math.round(PY_TIMEOUT_MS / 60_000)} min — transcripteur relancé`);
      if (py) py.kill();
      resolve({ error: `transcription trop longue (> ${Math.round(PY_TIMEOUT_MS / 60_000)} min) — transcripteur relancé` });
    }, PY_TIMEOUT_MS);
  });
  return Promise.race([result, timeout]).then((r) => { clearTimeout(timer); return r; });
}

async function transcribeJob(job) {
  const res = await fetch(`${BASE}/api/jobs/${job.id}/audio`, {
    headers: { Authorization: `Bearer ${MCP_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`audio introuvable (${res.status})`);
  const dir = await mkdtemp(join(tmpdir(), "cs-dictee-"));
  try {
    const src = join(dir, "in.bin");
    await writeFile(src, Buffer.from(await res.arrayBuffer()));
    const wav = join(dir, "audio.wav");
    try {
      await run("ffmpeg", ["-v", "error", "-i", src, "-ac", "1", "-ar", "16000", "-y", wav]);
    } catch (e) {
      if (e?.code === "ENOENT") throw new Error("binaire manquant : ffmpeg (PATH du worker)");
      throw new Error(`ffmpeg : ${String(e.message).split("\n")[0]}`);
    }
    const out = await transcribeWav(wav);
    if (out.error) throw new Error(out.error);
    return { text: out.text, sec: out.sec };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- boucle ---------------------------------------------------------------

async function processJob(job) {
  try {
    await call("claim_job", { job_id: job.id, worker_label: WORKER_LABEL });
  } catch (e) {
    log(`claim perdu ${job.id} (${e.message})`);
    return;
  }
  const heartbeat = setInterval(() => {
    call("heartbeat_job", { job_id: job.id }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    if (job.kind === "extract") {
      const { source_kind, ref } = job.payload ?? {};
      if (typeof ref !== "string" || !ref) throw new Error("payload.ref manquant");
      log(`extract ${source_kind} ${ref}`);
      const { text, meta } = await (source_kind === "video" ? extractVideo(ref) : extractUrl(ref));
      await call("attach_extraction", { source_id: job.targetId, extracted_text: text, extracted_meta: meta });
      await call("complete_job", { job_id: job.id });
      log(`done ${job.id} (${text.length} caractères)`);
    } else if (job.kind === "transcribe") {
      log(`transcribe ${job.targetType} ${job.targetId}`);
      const { text, sec } = await transcribeJob(job);
      await call("complete_job", { job_id: job.id, result: { text } });
      log(`done ${job.id} (${sec}s) : ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
    }
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`échec ${job.id} : ${message}`);
    await call("fail_job", { job_id: job.id, error: message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick() {
  const jobs = await call("list_jobs", { status: "queued" });
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!KINDS.has(job.kind)) continue;
    if (job.kind === "extract" && job.targetType !== "source") continue;
    if (job.kind === "transcribe" && job.targetType !== "comment" && job.targetType !== "dictation") continue;
    await processJob(job);
  }
}

// Réveil : un tour de boucle dès qu'un job queued apparaît (SSE), sans attendre le poll.
let wake = () => {};
const sleepOrWake = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  wake = () => { clearTimeout(t); resolve(); };
});

async function watchEvents() {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/events`, {
        headers: { Authorization: `Bearer ${MCP_TOKEN}`, accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
      log("abonné aux événements du workspace");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (!data) continue;
          try {
            const e = JSON.parse(data);
            if (e.type === "job.updated" && e.status === "queued" && KINDS.has(e.kind)) wake();
          } catch { /* trame illisible */ }
        }
      }
      throw new Error("flux fermé");
    } catch (e) {
      log(`événements : ${e.message} — reconnexion dans 3 s`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

await connect();
log(`${WORKER_LABEL} branché sur ${MCP_URL}${ONCE ? " (--once)" : ""}`);
if (!ONCE) watchEvents();
// Arrêt propre : SIGINT/SIGTERM ferment proprement le transcripteur avant de sortir.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { if (py) { stopping = true; py.stdin.end(); } process.exit(0); });
do {
  try {
    await tick();
  } catch (e) {
    console.error(`boucle : ${e instanceof Error ? e.message : e}`);
    // session MCP expirée ou serveur redémarré : on se rebranche
    try { await connect(); } catch { /* retentera au prochain tour */ }
  }
  if (!ONCE) await sleepOrWake(POLL_MS);
} while (!ONCE);
if (py) { stopping = true; py.stdin.end(); }
process.exit(0);
