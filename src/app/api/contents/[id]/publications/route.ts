import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getContent } from "@/lib/contents";
import { listPublications, bodyHash } from "@/lib/publications";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const content = await getContent(workspaceId, id);
    if (!content) return NextResponse.json({ error: "not found" }, { status: 404 });
    const hash = bodyHash(content.body);
    const pubs = await listPublications(workspaceId, { contentId: id });
    return NextResponse.json(pubs.map((p) => ({ ...p, stale: p.publishedBodyHash !== hash })));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
