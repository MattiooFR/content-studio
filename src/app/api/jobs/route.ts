import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createJob, listJobs, type JobStatus, type JobTargetType } from "@/lib/jobs";
import { updateIdea } from "@/lib/ideas";
import { getContent, setContentStatus } from "@/lib/contents";

const TARGET_TYPES = ["idea", "content", "comment"] as const;
const STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const sp = req.nextUrl.searchParams;
    const targetType = sp.get("target_type") ?? undefined;
    const status = sp.get("status") ?? undefined;
    if (targetType && !TARGET_TYPES.includes(targetType as never))
      return NextResponse.json({ error: "target_type invalide" }, { status: 400 });
    if (status && !STATUSES.includes(status as never))
      return NextResponse.json({ error: "status invalide" }, { status: 400 });
    return NextResponse.json(await listJobs(workspaceId, {
      targetType: targetType as JobTargetType | undefined,
      targetId: sp.get("target_id") ?? undefined,
      kind: sp.get("kind") ?? undefined,
      status: status as JobStatus | undefined,
    }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

/**
 * Création par l'UI. Effets des kinds intégrés (documentés dans la spec §1.4,
 * volontairement ICI et pas dans la lib : ce sont des conventions d'interface,
 * pas des règles du modèle) : write → idée in_progress ; publish → contenu
 * approved. Tout autre kind est accepté tel quel.
 */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "corps invalide" }, { status: 400 }); }
    if (typeof body !== "object" || body === null || Array.isArray(body))
      return NextResponse.json({ error: "corps invalide" }, { status: 400 });
    const { kind, target_type, target_id, payload, coalesce } = body;
    if (typeof kind !== "string" || !kind.trim())
      return NextResponse.json({ error: "kind requis" }, { status: 400 });
    if (!TARGET_TYPES.includes(target_type as never) || typeof target_id !== "string")
      return NextResponse.json({ error: "target_type et target_id requis" }, { status: 400 });
    if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload)))
      return NextResponse.json({ error: "payload doit être un objet" }, { status: 400 });
    const p = (payload ?? {}) as Record<string, unknown>;

    if (kind === "write" && typeof p.channel_key !== "string")
      return NextResponse.json({ error: "payload.channel_key requis pour write" }, { status: 400 });
    if (kind === "publish") {
      if (target_type !== "content") return NextResponse.json({ error: "publish vise un contenu" }, { status: 400 });
      const c = await getContent(workspaceId, target_id);
      if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
      if (!c.body.trim()) return NextResponse.json({ error: "corps vide : rien à publier" }, { status: 400 });
    }

    // « Re-synchroniser » (Task 9) vise une publication précise : sans clé de
    // dédoublonnage par publication_id, deux publications désynchronisées du
    // même contenu se coalesceraient sur un seul job sync (Finding 1, review
    // Task 7).
    const dedupeKey = kind === "sync" && typeof p.publication_id === "string" ? p.publication_id : undefined;
    const r = await createJob(workspaceId, {
      kind, targetType: target_type as JobTargetType, targetId: target_id,
      payload: p, requestedBy: `user:${userId}`, coalesce: coalesce === true,
      dedupeKey,
    });
    if (r.created) {
      if (kind === "write" && target_type === "idea") await updateIdea(workspaceId, target_id, { status: "in_progress" });
      if (kind === "publish") await setContentStatus(workspaceId, target_id, "approved");
    }
    return NextResponse.json(r, { status: r.created ? 201 : 200 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable"))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && (e.message.includes("requis") || e.message.includes("trop")))
      return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
