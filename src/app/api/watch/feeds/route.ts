import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getWatchConfig, upsertWatchFeed } from "@/lib/watch";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { feeds } = await getWatchConfig(workspaceId);
    return NextResponse.json({ feeds });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();

    if (typeof body.label !== "string" || !body.label.trim())
      return NextResponse.json({ error: "label requis" }, { status: 400 });

    // allow-list stricte : kind/label/params/enabled uniquement, jamais un
    // spread du body — upsertWatchFeed upserte sur (workspace, kind, label).
    const feed = await upsertWatchFeed(workspaceId, {
      kind: body.kind,
      label: body.label,
      params: body.params,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    });
    return NextResponse.json({ feed });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
