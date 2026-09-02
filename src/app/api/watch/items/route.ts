import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import {
  listWatchItems, expireStaleProposed, purgeStalePool, type WatchStatus,
} from "@/lib/watch";

const STATUSES: WatchStatus[] = ["pool", "proposed", "validated", "refused", "expired"];

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const statusParam = req.nextUrl.searchParams.get("status") ?? "proposed";
    if (!STATUSES.includes(statusParam as WatchStatus))
      return NextResponse.json({ error: "status inconnu" }, { status: 400 });
    const status = statusParam as WatchStatus;
    // effets paresseux — pas de cron dans l'outil (spec §4)
    if (status === "proposed") await expireStaleProposed(workspaceId);
    if (status === "pool") await purgeStalePool(workspaceId);
    const since = status === "pool" ? new Date(Date.now() - 7 * 86_400_000) : undefined;
    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
    const items = await listWatchItems(workspaceId, { status, since, limit });
    return NextResponse.json({ items });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
