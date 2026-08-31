import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { countWatchItems, expireStaleProposed } from "@/lib/watch";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    // effet paresseux : un badge de résumé ne doit pas surcompter des items
    // proposed dépassés faute d'un passage récent sur /api/watch/items (spec §4).
    await expireStaleProposed(workspaceId);
    const proposed = await countWatchItems(workspaceId, "proposed");
    return NextResponse.json({ proposed });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
