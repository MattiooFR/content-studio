import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getIdea, updateIdea } from "@/lib/ideas";

const IDEA_STATUSES = ["inbox", "in_progress", "done", "archived"] as const;

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const idea = await getIdea(workspaceId, (await params).id);
    if (!idea) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(idea);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();
    const patch: {
      title?: string; notes?: string; sourceUrl?: string; tags?: string[];
      status?: (typeof IDEA_STATUSES)[number];
    } = {};
    if (body.title !== undefined) patch.title = body.title;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.sourceUrl !== undefined) patch.sourceUrl = body.sourceUrl;
    if (body.tags !== undefined) patch.tags = body.tags;
    if (body.status !== undefined) {
      if (!IDEA_STATUSES.includes(body.status))
        return NextResponse.json({ error: "status invalide" }, { status: 400 });
      patch.status = body.status;
    }
    const idea = await updateIdea(workspaceId, (await params).id, patch);
    if (!idea) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(idea);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
