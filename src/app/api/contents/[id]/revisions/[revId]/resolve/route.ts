import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { resolveProposed } from "@/lib/contents";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; revId: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id, revId } = await params;
    const { action, expectedCurrentRevisionId } = await req.json();
    if (action !== "accept" && action !== "reject")
      return NextResponse.json({ error: "action accept|reject requise" }, { status: 400 });
    try {
      await resolveProposed({
        workspaceId, contentId: id, revisionId: revId, action,
        // Garde anti-écrasement : la révision courante que l'UI AFFICHAIT au clic.
        // Si le contenu a bougé entre le rendu du diff et le clic, la lib jette
        // "proposition périmée" -> 409, l'UI recharge et remontre le diff frais.
        expectedCurrentRevisionId: expectedCurrentRevisionId ?? null,
      });
    } catch (e) {
      if (e instanceof Error && e.message.includes("périmée"))
        return NextResponse.json({ error: e.message }, { status: 409 });
      throw e;
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
