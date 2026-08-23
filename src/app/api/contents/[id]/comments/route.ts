import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getContent } from "@/lib/contents";
import { listComments, createComment } from "@/lib/comments";

const STATUSES = ["open", "applied", "resolved"] as const;
type P = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: P) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { id } = await params;
    if (!(await getContent(workspaceId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    if (status && !STATUSES.includes(status as never)) return NextResponse.json({ error: "status invalide" }, { status: 400 });
    return NextResponse.json(await listComments(workspaceId, id, { status: status as never }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest, { params }: P) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const { id } = await params;
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "corps invalide" }, { status: 400 }); }
    if (typeof body?.body !== "string") return NextResponse.json({ error: "body requis" }, { status: 400 });
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
    const c = await createComment(workspaceId, {
      contentId: id, body: body.body, quote: str("quote"), prefix: str("prefix"), suffix: str("suffix"), section: str("section"), createdBy: userId,
    });
    return NextResponse.json(c, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable")) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && (e.message.includes("requis") || e.message.includes("trop long"))) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
