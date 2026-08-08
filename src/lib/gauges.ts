import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { gaugeSources } from "@/lib/db/schema";

type GaugeKind = "quota" | "cost";

// ---- contrat de payload (documenté au brief) ----------------------------
// { accounts?: [{id, usedPercent?, resetAt?, available?}], costMonthlyEur? }
// Champs inconnus IGNORÉS (comportement par défaut de z.object : les clés non
// déclarées sont retirées, pas rejetées) ; un type faux OU hors bornes sur un
// champ déclaré → échec de parsing → error, jamais de throw vers l'appelant.
// Bornes (durcissement DoS) : accounts plafonné à 50 entrées, id/resetAt à
// 200 caractères, usedPercent dans [0,100] — une valeur hors bornes est un
// payload CASSÉ (error), jamais clampée en silence : l'UI ne doit recevoir
// que du propre.
const gaugeAccountSchema = z.object({
  id: z.string().max(200),
  usedPercent: z.number().min(0).max(100).nullable().optional(),
  resetAt: z.string().max(200).nullable().optional(),
  available: z.boolean().optional(),
});

const gaugePayloadSchema = z.object({
  accounts: z.array(gaugeAccountSchema).max(50).optional(),
  costMonthlyEur: z.number().optional(),
});

export type GaugeAccount = z.infer<typeof gaugeAccountSchema>;
export type GaugePayload = z.infer<typeof gaugePayloadSchema>;

const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;
// Un payload de jauge est minuscule (quelques comptes + un nombre) : au-delà
// de 1 MiB, c'est hostile ou cassé. Lu par un reader manuel plafonné plutôt
// que `res.json()`/`res.text()`, qui bufferisent SANS borne — un bridge
// hostile (ou juste buggé) pourrait sinon gonfler la mémoire du serveur.
const MAX_BODY_BYTES = 1024 * 1024;

async function readBodyCapped(res: Response): Promise<{ text: string } | { error: string }> {
  if (!res.body) {
    // Pas de flux exposé (environnement inhabituel) : repli défensif, non
    // emprunté par fetch() Node/undici en pratique.
    return { text: await res.text() };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { error: "réponse trop grosse (> 1 MiB)" };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
}

/**
 * Interroge UNE source. Ne throw JAMAIS vers l'appelant : toute défaillance
 * (réseau, timeout, HTTP non-2xx, JSON invalide, contrat non respecté)
 * devient `{ error }`. C'est ce qui permet à refreshGauges de rester
 * Promise.allSettled-safe et à l'affichage de ne jamais planter sur une
 * source injoignable — juste une jauge grise.
 */
export async function fetchGaugeSource(
  source: { url: string; headers: Record<string, string> }
): Promise<{ payload: GaugePayload } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(source.url, {
      headers: source.headers,
      signal: controller.signal,
      // Jamais de redirection suivie : un endpoint approuvé à la création
      // pourrait plus tard répondre par un 302 vers une IP interne, en
      // embarquant le header custom (x-api-key) vers la cible redirigée.
      // Un bridge légitime n'a aucune raison de rediriger.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      return { error: "redirection refusée (3xx)" };
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }

    const body = await readBodyCapped(res);
    if ("error" in body) return body;

    let json: unknown;
    try {
      json = JSON.parse(body.text);
    } catch {
      return { error: "réponse non-JSON" };
    }
    const parsed = gaugePayloadSchema.safeParse(json);
    if (!parsed.success) {
      return { error: "payload invalide : ne respecte pas le contrat de jauge" };
    }
    return { payload: parsed.data };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { error: `timeout : pas de réponse en ${FETCH_TIMEOUT_MS / 1000} s` };
    }
    return { error: e instanceof Error ? e.message : "erreur inconnue" };
  } finally {
    clearTimeout(timer);
  }
}

// ---- SSRF : IP littérales privées évidentes ------------------------------
// Portée VOLONTAIREMENT limitée aux IP écrites en clair dans l'URL, à la
// CRÉATION seulement. Ça n'empêche pas un hostname qui résout vers du privé
// (DNS rebinding) — la vraie protection d'un déploiement SaaS est l'egress
// réseau (firewall sortant), pas cette liste. En self-host, les bridges
// locaux de l'utilisateur SONT le cas d'usage : localhost et 127.0.0.1 sont
// donc explicitement autorisés, alors que le reste de la plage 127.0.0.0/8
// (souvent utilisée pour désigner d'autres process locaux qu'on ne veut pas
// exposer par erreur) reste refusé, comme 10.*, 192.168.*, 169.254.*,
// 172.16.0.0/12 (172.16.* à 172.31.*, RFC1918 — manquait initialement),
// 100.64.0.0/10 (100.64.* à 100.127.*, CGNAT partagé — manquait
// initialement, largement utilisé par les fournisseurs cloud/VPN pour du
// routage interne) et 0.0.0.0. IPv6 littéral : bloqué EN BLOC sauf `[::1]`
// (même logique que 127.0.0.1) — pas de parsing fin des plages
// ULA/link-local, un refus large coûte trois lignes et rien de légitime ne
// perd au change en self-host.
function isDisallowedPrivateLiteralIp(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (host.startsWith("[") && host.endsWith("]")) {
    return host !== "[::1]";
  }

  if (host === "localhost" || host === "127.0.0.1") return false;
  if (host === "0.0.0.0") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // 172.16.0.0/12 : 2e octet dans [16,31].
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // 100.64.0.0/10 : 2e octet dans [64,127].
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  return false;
}

const MAX_URL_LENGTH = 500;

function validateUrl(url: string): string {
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`url trop longue (max ${MAX_URL_LENGTH} caractères)`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL invalide (http/https attendu)");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL invalide (http/https attendu)");
  }
  if (isDisallowedPrivateLiteralIp(parsed.hostname)) {
    throw new Error(
      "URL refusée : IP privée non autorisée (seuls localhost/127.0.0.1/[::1] sont permis en self-host)"
    );
  }
  return url;
}

// headers jsonb : valeurs STRING uniquement. C'est ici que vivra un
// x-api-key utilisateur — PAS de chiffrement en v1 self-host (le
// déploiement tourne sur la machine de l'utilisateur ; chiffrer app-level
// sans HSM/KMS ne protège de rien de plus qu'un accès direct à la db, déjà
// nécessaire pour lire le reste du workspace). À revoir si/quand une offre
// SaaS multi-tenant est envisagée.
// Bornes (durcissement DoS, cf. name/url ci-dessus) : 20 headers maximum,
// valeurs de 500 caractères maximum.
const MAX_HEADER_COUNT = 20;
const MAX_HEADER_VALUE_LENGTH = 500;

function validateHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new Error("headers invalide : objet de chaînes attendu");
  }
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADER_COUNT) {
    throw new Error(`headers invalide : ${MAX_HEADER_COUNT} maximum`);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "string") {
      throw new Error(`headers invalide : la valeur de "${key}" doit être une chaîne`);
    }
    if (value.length > MAX_HEADER_VALUE_LENGTH) {
      throw new Error(
        `headers invalide : la valeur de "${key}" dépasse ${MAX_HEADER_VALUE_LENGTH} caractères`
      );
    }
    result[key] = value;
  }
  return result;
}

const MAX_NAME_LENGTH = 100;

type CreateGaugeSourceInput = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  kind: GaugeKind;
};

export async function createGaugeSource(workspaceId: string, input: CreateGaugeSourceInput) {
  if (!input.name?.trim()) throw new Error("name requis");
  if (input.name.length > MAX_NAME_LENGTH) {
    throw new Error(`name trop long (max ${MAX_NAME_LENGTH} caractères)`);
  }
  if (input.kind !== "quota" && input.kind !== "cost") {
    throw new Error("kind invalide (quota|cost attendu)");
  }
  const url = validateUrl(input.url);
  const headers = validateHeaders(input.headers);

  const [row] = await db.insert(gaugeSources)
    .values({ workspaceId, name: input.name, url, headers, kind: input.kind })
    .returning();
  return row;
}

export async function listGaugeSources(workspaceId: string) {
  return db.select().from(gaugeSources).where(eq(gaugeSources.workspaceId, workspaceId));
}

export async function getGaugeSource(workspaceId: string, id: string) {
  const [row] = await db.select().from(gaugeSources)
    .where(and(eq(gaugeSources.id, id), eq(gaugeSources.workspaceId, workspaceId)));
  return row ?? null;
}

export async function updateGaugeSource(
  workspaceId: string, id: string, patch: { enabled?: boolean }
) {
  const update: Record<string, unknown> = {};
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (Object.keys(update).length === 0) return getGaugeSource(workspaceId, id);

  const [row] = await db.update(gaugeSources)
    .set(update as never)
    .where(and(eq(gaugeSources.id, id), eq(gaugeSources.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

export async function deleteGaugeSource(workspaceId: string, id: string) {
  const [row] = await db.delete(gaugeSources)
    .where(and(eq(gaugeSources.id, id), eq(gaugeSources.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

/**
 * Polle toutes les sources ENABLED du workspace. Promise.allSettled : chaque
 * source est isolée, l'échec (réseau OU écriture db) de l'une ne bloque
 * jamais la persistance des autres. Pas de cron — appelée par
 * `getGaugesState`, elle-même déclenchée par l'affichage (GET /api/gauges).
 */
export async function refreshGauges(workspaceId: string) {
  const rows = await db.select().from(gaugeSources)
    .where(and(eq(gaugeSources.workspaceId, workspaceId), eq(gaugeSources.enabled, true)));

  await Promise.allSettled(
    rows.map(async (source) => {
      const result = await fetchGaugeSource({
        url: source.url,
        headers: (source.headers ?? {}) as Record<string, string>,
      });
      const now = new Date();
      if ("payload" in result) {
        await db.update(gaugeSources)
          .set({ lastPayload: result.payload, lastError: null, lastFetchedAt: now })
          .where(eq(gaugeSources.id, source.id));
      } else {
        await db.update(gaugeSources)
          .set({ lastError: result.error, lastFetchedAt: now })
          .where(eq(gaugeSources.id, source.id));
      }
    })
  );

  return listGaugeSources(workspaceId);
}

function isStale(lastFetchedAt: Date | null): boolean {
  if (!lastFetchedAt) return true;
  return Date.now() - lastFetchedAt.getTime() > CACHE_TTL_MS;
}

// GET /api/gauges est pollé EN CLAIR par le navigateur (SubscriptionGauges,
// toutes les 5 min + bouton manuel) : les VALEURS de `headers` (où vit un
// x-api-key utilisateur, cf. validateHeaders plus haut) ne doivent JAMAIS
// atterrir dans cette réponse — sinon chaque poll les exfiltre au client
// pour rien, la page réglages ne les relit même pas (elle les redemande à
// l'édition). Seules les CLÉS sortent (utile pour un futur affichage
// "headers déjà configurés" côté réglages), jamais les valeurs.
//
// Exportée : PATCH /api/gauges/[id] (updateGaugeSource, toggle
// enabled/disabled) renvoie lui aussi la ligne complète au client à chaque
// appel — même fuite que GET si elle n'est pas redigée ici aussi, juste
// déclenchée par un clic plutôt qu'un poll.
export function redactHeadersForClient<T extends { headers: unknown }>(
  row: T
): Omit<T, "headers"> & { headerKeys: string[] } {
  const { headers, ...rest } = row;
  return { ...rest, headerKeys: Object.keys((headers ?? {}) as Record<string, string>) };
}

/**
 * État agrégé consommé par GET /api/gauges. Sans ?refresh=1, ne repolle QUE
 * si une source enabled n'a jamais été fetchée ou est périmée (>5 min) —
 * sinon rend l'état stocké tel quel (pas d'appel réseau à chaque affichage).
 */
export async function getGaugesState(
  workspaceId: string, opts: { refresh?: boolean } = {}
) {
  const current = await listGaugeSources(workspaceId);
  const needsRefresh =
    opts.refresh === true ||
    current.some((s) => s.enabled && isStale(s.lastFetchedAt));

  const sources = needsRefresh ? await refreshGauges(workspaceId) : current;

  const totalCostEur = sources
    .filter((s) => s.enabled && s.kind === "cost")
    .reduce((sum, s) => {
      // jsonb NOT NULL n'empêche pas la valeur JSON littérale `null` (un
      // update manuel en DB self-host peut la poser) — `?? {}` avant le cast
      // pour ne jamais déréférencer `null`.
      const payload = (s.lastPayload ?? {}) as GaugePayload;
      return typeof payload.costMonthlyEur === "number" ? sum + payload.costMonthlyEur : sum;
    }, 0);

  return { sources: sources.map(redactHeadersForClient), totalCostEur };
}
