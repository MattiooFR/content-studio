import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { gaugeSources } from "@/lib/db/schema";

type GaugeKind = "quota" | "cost";

// ---- contrat de payload (documenté au brief) ----------------------------
// { accounts?: [{id, usedPercent?, resetAt?, available?}], costMonthlyEur? }
// Champs inconnus IGNORÉS (comportement par défaut de z.object : les clés non
// déclarées sont retirées, pas rejetées) ; un type faux sur un champ déclaré
// → échec de parsing → error, jamais de throw vers l'appelant.
const gaugeAccountSchema = z.object({
  id: z.string(),
  usedPercent: z.number().nullable().optional(),
  resetAt: z.string().nullable().optional(),
  available: z.boolean().optional(),
});

const gaugePayloadSchema = z.object({
  accounts: z.array(gaugeAccountSchema).optional(),
  costMonthlyEur: z.number().optional(),
});

export type GaugeAccount = z.infer<typeof gaugeAccountSchema>;
export type GaugePayload = z.infer<typeof gaugePayloadSchema>;

const FETCH_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
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
// exposer par erreur) reste refusé, comme 10.*, 192.168.* et 169.254.*.
function isDisallowedPrivateLiteralIp(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  if (/^127\./.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  return false;
}

function validateUrl(url: string): string {
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
      "URL refusée : IP privée non autorisée (seuls localhost/127.0.0.1 sont permis en self-host)"
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
function validateHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    throw new Error("headers invalide : objet de chaînes attendu");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new Error(`headers invalide : la valeur de "${key}" doit être une chaîne`);
    }
    result[key] = value;
  }
  return result;
}

type CreateGaugeSourceInput = {
  name: string;
  url: string;
  headers?: Record<string, string>;
  kind: GaugeKind;
};

export async function createGaugeSource(workspaceId: string, input: CreateGaugeSourceInput) {
  if (!input.name?.trim()) throw new Error("name requis");
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
      const payload = s.lastPayload as GaugePayload;
      return typeof payload.costMonthlyEur === "number" ? sum + payload.costMonthlyEur : sum;
    }, 0);

  return { sources, totalCostEur };
}
