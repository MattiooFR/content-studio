import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { validateWatchItem, refuseWatchItem, createIdeaFromPoolItem } from "@/lib/watch";
import { db } from "@/lib/db";
import { watchItems } from "@/lib/db/schema";

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const body = await req.json();

    // Existence + cloisonnement vérifiés ICI, avant tout dispatch : certaines
    // gardes de statut des libs (ex. refuseWatchItem) rendent le même message
    // générique qu'un item existe mais au mauvais statut ou qu'il n'existe pas
    // du tout dans ce workspace — sans ce contrôle, un item d'un autre
    // workspace tomberait en 400 au lieu du 404 attendu par le contrat.
    const [existing] = await db.select({ id: watchItems.id }).from(watchItems)
      .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.id, id)));
    if (!existing)
      return NextResponse.json({ error: "item introuvable dans ce workspace" }, { status: 404 });

    // allow-list stricte : action/edited_text/reason/note uniquement, jamais un spread du body.
    switch (body.action) {
      case "validate": {
        const editedText = typeof body.edited_text === "string" ? body.edited_text : undefined;
        const result = await validateWatchItem(workspaceId, id, { editedText });
        return NextResponse.json(result);
      }
      case "refuse": {
        const reason = typeof body.reason === "string" ? body.reason : undefined;
        const note = typeof body.note === "string" ? body.note : undefined;
        const item = await refuseWatchItem(workspaceId, id, { reason, note });
        return NextResponse.json({ item });
      }
      case "create_idea": {
        const { ideaId } = await createIdeaFromPoolItem(workspaceId, id);
        // createIdeaFromPoolItem ne rend que l'id de l'idée créée : on relit
        // l'item (pool inchangé sinon ideaId posé) pour tenir le contrat de
        // réponse commun aux trois actions ({ item } + champs propres à l'action).
        const [item] = await db.select().from(watchItems)
          .where(and(eq(watchItems.workspaceId, workspaceId), eq(watchItems.id, id)));
        return NextResponse.json({ item, ideaId });
      }
      default:
        return NextResponse.json({ error: "action inconnue" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) {
      const status = e.message.includes("introuvable") ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}
