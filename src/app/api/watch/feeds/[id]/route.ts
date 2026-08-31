import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { deleteWatchFeed, setWatchFeedEnabled } from "@/lib/watch";

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const body = await req.json();
    if (typeof body.enabled !== "boolean")
      return NextResponse.json({ error: "enabled (booléen) requis" }, { status: 400 });

    // allow-list stricte : enabled uniquement, jamais un spread du body.
    const feed = await setWatchFeedEnabled(workspaceId, id, body.enabled);
    return NextResponse.json({ feed });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) {
      const status = e.message.includes("introuvable") ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}

export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    await deleteWatchFeed(workspaceId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) {
      const status = e.message.includes("introuvable") ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }
}
