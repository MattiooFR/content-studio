import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getContent, applyContentUpdate, setContentStatus } from "@/lib/contents";

const STATUSES = ["draft", "review", "approved", "published", "generating"] as const;

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const c = await getContent(workspaceId, (await params).id);
    if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(c);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function PATCH(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const patch = await req.json();
    if (typeof patch.body === "string") {
      const r = await applyContentUpdate({
        workspaceId, contentId: id, body: patch.body, authorType: "user",
      });
      return NextResponse.json(r);
    }
    if (patch.status) {
      if (!STATUSES.includes(patch.status))
        return NextResponse.json({ error: "status invalide" }, { status: 400 });
      return NextResponse.json(await setContentStatus(workspaceId, id, patch.status));
    }
    return NextResponse.json({ error: "body ou status requis" }, { status: 400 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable"))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
