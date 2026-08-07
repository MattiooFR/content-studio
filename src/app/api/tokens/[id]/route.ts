import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, revokeMcpToken, TenantError } from "@/lib/tenant";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    await revokeMcpToken(workspaceId, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
