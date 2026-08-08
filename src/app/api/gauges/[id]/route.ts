import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { updateGaugeSource, deleteGaugeSource, redactHeadersForClient } from "@/lib/gauges";

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();
    if (typeof body.enabled !== "boolean")
      return NextResponse.json({ error: "enabled (booléen) requis" }, { status: 400 });

    const row = await updateGaugeSource(workspaceId, (await params).id, { enabled: body.enabled });
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Même durcissement que GET /api/gauges (getGaugesState) : ce toggle
    // renvoie la ligne à chaque clic, les VALEURS de headers (x-api-key…)
    // n'ont rien à y faire — voir redactHeadersForClient dans gauges.ts.
    return NextResponse.json(redactHeadersForClient(row));
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
    const row = await deleteGaugeSource(workspaceId, (await params).id);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
