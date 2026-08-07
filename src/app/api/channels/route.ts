import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { db } from "@/lib/db";
import { channels } from "@/lib/db/schema";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    return NextResponse.json(
      await db.select().from(channels).where(eq(channels.workspaceId, workspaceId))
    );
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
