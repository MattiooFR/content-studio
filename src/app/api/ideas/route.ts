import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { listIdeas, createIdea } from "@/lib/ideas";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    return NextResponse.json(await listIdeas(workspaceId, status));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const body = await req.json();
    if (!body.title) return NextResponse.json({ error: "title requis" }, { status: 400 });
    return NextResponse.json(
      await createIdea(workspaceId, {
        title: body.title,
        notes: body.notes,
        sourceUrl: body.sourceUrl,
        tags: body.tags,
        createdBy: userId,
      })
    );
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
