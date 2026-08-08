import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ideas, sources } from "@/lib/db/schema";
import { resolveMcpToken } from "@/lib/tenant";
import {
  MAX_SOURCE_EXCERPT_LENGTH, MAX_SOURCE_REF_LENGTH, MAX_SOURCE_TITLE_LENGTH,
} from "@/lib/sources";

// CORS pour l'extension Chrome (W5) UNIQUEMENT.
//
// L'extension demande une optional_host_permission au moment où l'utilisateur
// configure son instance (chrome.permissions.request) : côté navigateur, ça
// suffit à bypasser CORS sans aucun header serveur. Ce handler est le
// filet de secours pour le cas où cette permission a été refusée, ou pour
// tout appel direct depuis le contexte du popup/service worker qui déclenche
// quand même un preflight. Restreint à une origine `chrome-extension://` —
// jamais un `Access-Control-Allow-Origin: *`, et jamais pour une origine web
// classique (le reste de l'app reste same-origin only).
function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !origin.startsWith("chrome-extension://")) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin",
  };
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get("origin");
  return new NextResponse(null, {
    status: 204,
    headers: { ...corsHeaders(origin), "Access-Control-Max-Age": "86400" },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const json = (data: unknown, status = 200) =>
    NextResponse.json(data, { status, headers: corsHeaders(origin) });

  try {
    // Auth: Bearer token
    const auth = await resolveMcpToken(req.headers.get("authorization"));
    if (!auth) {
      return json({ error: "unauthorized" }, 401);
    }

    // Parse body — un corps non-JSON (extension buggée, appel manuel cassé,
    // sonde hostile) throw sur req.json() : jamais laissé remonter en 500,
    // toujours une 400 lisible. Idem pour un JSON valide mais qui n'est pas
    // un objet à plat (null, tableau, string, nombre) — la destructuration
    // qui suit throw sur `null` sans ce garde-fou.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "corps invalide" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ error: "corps invalide" }, 400);
    }
    const { url, title, selection } = body as Record<string, unknown>;

    // Validation : URL est obligatoire et string
    if (typeof url !== "string" || !url.trim()) {
      return json({ error: "URL invalide (http/https attendu)" }, 400);
    }

    // Validation : title et selection sont ignorés s'ils ne sont pas des strings

    // Validation : URL a un protocole valide (http/https)
    // Cette logique est dupliquée d'addSource pour la valider EN PREMIER,
    // avant toute création, afin d'éviter une idée orpheline.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return json({ error: "URL invalide (http/https attendu)" }, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return json({ error: "URL invalide (http/https attendu)" }, 400);
    }

    // Bornes anti-DoS (durcissement, mêmes constantes qu'addSource — voir
    // src/lib/sources.ts) : une valeur hors bornes est une entrée CASSÉE
    // (400), jamais tronquée en silence. Ignoré si non-string : cohérent
    // avec la validation title/selection ci-dessus (juste au-dessus), qui
    // tombe alors sur son fallback plutôt que d'échouer.
    if (url.length > MAX_SOURCE_REF_LENGTH) {
      return json({ error: `URL trop longue (max ${MAX_SOURCE_REF_LENGTH} caractères)` }, 400);
    }
    if (typeof title === "string" && title.length > MAX_SOURCE_TITLE_LENGTH) {
      return json({ error: `title trop long (max ${MAX_SOURCE_TITLE_LENGTH} caractères)` }, 400);
    }
    if (typeof selection === "string" && selection.length > MAX_SOURCE_EXCERPT_LENGTH) {
      return json(
        { error: `selection trop longue (max ${MAX_SOURCE_EXCERPT_LENGTH} caractères)` }, 400
      );
    }

    // Title fallback (ignoré si non-string)
    const finalTitle = typeof title === "string" ? title : url;

    // Selection fallback (ignoré si non-string)
    const finalSelection = typeof selection === "string" ? selection : "";

    // Transaction : créer l'idée, puis la source. Tout ou rien.
    const result = await db.transaction(async (tx) => {
      // Insérer l'idée
      const [idea] = await tx.insert(ideas)
        .values({
          workspaceId: auth.workspaceId,
          title: finalTitle,
          status: "inbox",
          createdBy: "clipper",
        })
        .returning();

      if (!idea) throw new Error("Erreur lors de la création de l'idée");

      // Insérer la source avec la même validation qu'addSource
      const [source] = await tx.insert(sources)
        .values({
          workspaceId: auth.workspaceId,
          ideaId: idea.id,
          kind: "url",
          ref: url,
          rawExcerpt: finalSelection,
          createdBy: "clipper",
        })
        .returning();

      if (!source) throw new Error("Erreur lors de la création de la source");

      return { ideaId: idea.id, sourceId: source.id };
    });

    return json(result);
  } catch (e) {
    if (e instanceof Error && e.message.includes("unauthorized")) {
      return json({ error: "unauthorized" }, 401);
    }
    if (e instanceof Error && e.message.includes("invalide")) {
      return json({ error: e.message }, 400);
    }
    throw e;
  }
}
