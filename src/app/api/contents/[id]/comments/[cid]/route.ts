import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getComment, updateComment, deleteComment } from "@/lib/comments";

const STATUSES = ["open", "applied", "resolved"] as const;
type P = { params: Promise<{ id: string; cid: string }> };

export async function PATCH(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id, cid } = await params;
    const existing = await getComment(workspaceId, cid);
    if (!existing || existing.contentId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const patch: { body?: string; status?: (typeof STATUSES)[number] } = {};
    if (body.body !== undefined) {
      if (typeof body.body !== "string") return NextResponse.json({ error: "body doit être une chaîne" }, { status: 400 });
      patch.body = body.body;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return NextResponse.json({ error: "status invalide" }, { status: 400 });
      patch.status = body.status;
    }
    const row = await updateComment(workspaceId, cid, patch);
    return NextResponse.json(row);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id, cid } = await params;
    const existing = await getComment(workspaceId, cid);
    if (!existing || existing.contentId !== id) return NextResponse.json({ error: "not found" }, { status: 404 });
    await deleteComment(workspaceId, cid);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
