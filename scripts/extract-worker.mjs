#!/usr/bin/env node
// scripts/extract-worker.mjs — worker d'extraction des sources.
//
// Tourne sur le Mac (là où vivent yt-dlp et mlx_whisper) et parle
// EXCLUSIVEMENT MCP à content-studio, comme n'importe quel worker — jamais
// la base en direct.
//
//   CS_MCP_URL=http://localhost:3003/api/mcp CS_MCP_TOKEN=cs_… \
//     node scripts/extract-worker.mjs [--once]
//
// kinds pris en charge (payload.source_kind) :
//   url   → fetch + Readability (HTML uniquement — un PDF est refusé avec un
//           message qui invite à déposer le texte à la main)
//   video → yt-dlp -x (audio temporaire) + mlx_whisper (large-v3-turbo)
// Tout échec → fail_job(message lisible) : la source passe failed côté outil,
// le bouton Réessayer la remet en pending.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const run = promisify(execFile);
const MCP_URL = process.env.CS_MCP_URL;
const MCP_TOKEN = process.env.CS_MCP_TOKEN;
const WHISPER_MODEL = process.env.CS_WHISPER_MODEL ?? "mlx-community/whisper-large-v3-turbo";
const ONCE = process.argv.includes("--once");
const POLL_MS = 15_000;
const HEARTBEAT_MS = 60_000; // le serveur bascule un running en failed après 10 min de silence
const WORKER_LABEL = `extract-worker@${hostname()}`;

if (!MCP_URL || !MCP_TOKEN) {
  console.error("CS_MCP_URL et CS_MCP_TOKEN requis (token workspace : UI → Réglages → Tokens MCP)");
  process.exit(1);
}

let client;
async function connect() {
  client = new Client({ name: "extract-worker", version: "1.0.0" });
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

// ---- extracteurs -----------------------------------------------------------

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
    host === "[::1]" || host.startsWith("[fe80:") || host.startsWith("[fc") || host.startsWith("[fd");
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
  const { document } = parseHTML(await res.text());
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

// ---- boucle ---------------------------------------------------------------

async function processJob(job) {
  try {
    await call("claim_job", { job_id: job.id, worker_label: WORKER_LABEL });
  } catch (e) {
    console.log(`claim perdu ${job.id} (${e.message})`);
    return;
  }
  const heartbeat = setInterval(() => {
    call("heartbeat_job", { job_id: job.id }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    const { source_kind, ref } = job.payload ?? {};
    if (typeof ref !== "string" || !ref) throw new Error("payload.ref manquant");
    console.log(`extract ${source_kind} ${ref}`);
    const { text, meta } = await (source_kind === "video" ? extractVideo(ref) : extractUrl(ref));
    await call("attach_extraction", {
      source_id: job.targetId, extracted_text: text, extracted_meta: meta,
    });
    await call("complete_job", { job_id: job.id });
    console.log(`done ${job.id} (${text.length} caractères)`);
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
    console.error(`échec ${job.id} : ${message}`);
    await call("fail_job", { job_id: job.id, error: message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function tick() {
  const jobs = await call("list_jobs", { status: "queued", kind: "extract" });
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job.targetType !== "source") continue;
    await processJob(job);
  }
}

await connect();
console.log(`${WORKER_LABEL} branché sur ${MCP_URL}${ONCE ? " (--once)" : ""}`);
do {
  try {
    await tick();
  } catch (e) {
    console.error(`boucle : ${e instanceof Error ? e.message : e}`);
    // session MCP expirée ou serveur redémarré : on se rebranche
    try { await connect(); } catch { /* retentera au prochain tour */ }
  }
  if (!ONCE) await new Promise((r) => setTimeout(r, POLL_MS));
} while (!ONCE);
process.exit(0);
