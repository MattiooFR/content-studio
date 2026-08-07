import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpTokens } from "@/lib/db/schema";
import { requireWorkspace, generateMcpToken, TenantError } from "@/lib/tenant";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const rows = await db.select({
      id: mcpTokens.id, label: mcpTokens.label, prefix: mcpTokens.prefix,
      lastUsedAt: mcpTokens.lastUsedAt, revokedAt: mcpTokens.revokedAt,
      createdAt: mcpTokens.createdAt,
    }).from(mcpTokens).where(eq(mcpTokens.workspaceId, workspaceId));
    return NextResponse.json(rows);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { label } = await req.json();
    if (!label) return NextResponse.json({ error: "label requis" }, { status: 400 });
    // le token en clair n'est montré qu'UNE fois, à la création
    return NextResponse.json(await generateMcpToken(workspaceId, label));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
