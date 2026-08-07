import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ideas, sources } from "@/lib/db/schema";
import { resolveMcpToken } from "@/lib/tenant";

export async function POST(req: NextRequest) {
  try {
    // Auth: Bearer token
    const auth = await resolveMcpToken(req.headers.get("authorization"));
    if (!auth) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    // Parse body
    const body = await req.json();
    const { url, title, selection } = body;

    // Validation : URL est obligatoire et string
    if (typeof url !== "string" || !url.trim()) {
      return NextResponse.json({ error: "URL invalide (http/https attendu)" }, { status: 400 });
    }

    // Validation : title et selection sont ignorés s'ils ne sont pas des strings

    // Validation : URL a un protocole valide (http/https)
    // Cette logique est dupliquée d'addSource pour la valider EN PREMIER,
    // avant toute création, afin d'éviter une idée orpheline.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: "URL invalide (http/https attendu)" }, { status: 400 });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return NextResponse.json({ error: "URL invalide (http/https attendu)" }, { status: 400 });
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

    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Error && e.message.includes("unauthorized")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (e instanceof Error && e.message.includes("invalide")) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
