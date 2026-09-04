import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createDictation, listDictations } from "@/lib/dictations";
import { MAX_AUDIO_BYTES, isSupportedAudioMime, readBodyBounded } from "@/lib/audio";

/** Dépôt d'une dictée : le corps de la requête EST l'audio, le champ d'origine passe en query. */
export async function POST(req: NextRequest) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const mime = (req.headers.get("content-type") ?? "").trim();
    if (!isSupportedAudioMime(mime)) return NextResponse.json({ error: "type audio non supporté" }, { status: 415 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const buf = await readBodyBounded(req, MAX_AUDIO_BYTES);
    if (buf === null) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const fieldKey = req.nextUrl.searchParams.get("field_key") ?? "";
    const { dictation } = await createDictation(workspaceId, { audio: buf, mime, fieldKey, createdBy: userId });
    return NextResponse.json({ id: dictation.id, status: dictation.status, fieldKey: dictation.fieldKey }, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("audio vide")) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("trop gros")) return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof Error && e.message.includes("mime")) return NextResponse.json({ error: e.message }, { status: 415 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** Liste sans audio. `open=1` + `field_key` = ce qu'un champ attend encore (pending, ou done non consommée). */
export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const rows = await listDictations(workspaceId, {
      status: status === "pending" || status === "done" || status === "failed" ? status : undefined,
      fieldKey: sp.get("field_key") ?? undefined,
      open: sp.get("open") === "1",
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
    });
    return NextResponse.json(rows);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
