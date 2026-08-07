import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createLane, listLanes } from "@/lib/lanes";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    return NextResponse.json(await listLanes(workspaceId));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json().catch(() => ({}));
    if (body.title !== undefined && typeof body.title !== "string") {
      return NextResponse.json({ error: "title doit être une chaîne" }, { status: 400 });
    }
    // allow-list stricte : title uniquement, jamais un spread du body.
    const lane = await createLane(workspaceId, { title: body.title });
    return NextResponse.json(lane);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
