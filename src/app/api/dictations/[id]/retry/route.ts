import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { retryDictation } from "@/lib/dictations";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const d = await retryDictation(workspaceId, (await params).id);
    if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(d);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("réessai refusé")) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
