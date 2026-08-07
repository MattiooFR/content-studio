import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createContentDraft, listContents } from "@/lib/contents";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const ideaId = req.nextUrl.searchParams.get("ideaId") ?? undefined;
    return NextResponse.json(await listContents(workspaceId, ideaId));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { ideaId, channelKey, personaId } = await req.json();
    if (!ideaId || !channelKey)
      return NextResponse.json({ error: "ideaId et channelKey requis" }, { status: 400 });
    return NextResponse.json(
      await createContentDraft({ workspaceId, ideaId, channelKey, personaId })
    );
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.startsWith("channel inconnu"))
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("introuvable"))
      return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
