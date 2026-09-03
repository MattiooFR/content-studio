import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getSource } from "@/lib/sources";

// La liste (/api/ideas/[id]/sources) est allégée (sans extracted_text) ;
// cette route rend UNE source complète — le panneau de la fiche idée la
// charge au clic.
export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const source = await getSource(workspaceId, (await params).id);
    if (!source) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(source);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
