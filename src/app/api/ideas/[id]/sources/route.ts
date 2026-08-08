import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getIdea } from "@/lib/ideas";
import { addSource, listSources } from "@/lib/sources";

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const ideaId = (await params).id;
    const idea = await getIdea(workspaceId, ideaId);
    if (!idea) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(await listSources(workspaceId, { ideaId }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const ideaId = (await params).id;
    const { kind, ref, title, rawExcerpt } = await req.json();
    if (!kind || !ref)
      return NextResponse.json({ error: "kind et ref requis" }, { status: 400 });
    const source = await addSource(workspaceId, {
      ideaId, kind, ref, title, rawExcerpt, createdBy: userId,
    });
    return NextResponse.json(source);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable"))
      return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof Error && e.message.includes("non disponible"))
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("URL invalide"))
      return NextResponse.json({ error: e.message }, { status: 400 });
    // Bornes anti-DoS d'addSource (durcissement, cf. src/lib/sources.ts) :
    // "ref/title/rawExcerpt trop long(ue)" → 400, jamais un 500 générique.
    if (e instanceof Error && e.message.includes("trop long"))
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
