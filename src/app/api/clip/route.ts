import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ideas, sources } from "@/lib/db/schema";
import { resolveMcpToken } from "@/lib/tenant";

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

    // Parse body
    const body = await req.json();
    const { url, title, selection } = body;

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
