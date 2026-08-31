import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { deleteWatchFeed } from "@/lib/watch";
import { db } from "@/lib/db";
import { watchFeeds } from "@/lib/db/schema";

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const body = await req.json();
    if (typeof body.enabled !== "boolean")
      return NextResponse.json({ error: "enabled (booléen) requis" }, { status: 400 });

    // allow-list stricte : enabled uniquement, jamais un spread du body — pas
    // de fonction dédiée dans lib/watch.ts pour ce toggle par id (upsertWatchFeed
    // upserte sur kind+label, pas sur id), écriture directe cloisonnée ici même.
    const [row] = await db.update(watchFeeds).set({ enabled: body.enabled })
      .where(and(eq(watchFeeds.id, id), eq(watchFeeds.workspaceId, workspaceId)))
      .returning();
    if (!row) return NextResponse.json({ error: "feed introuvable dans ce workspace" }, { status: 404 });
    return NextResponse.json({ feed: row });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
