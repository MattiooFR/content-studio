import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createVoiceComment } from "@/lib/comments";
import { MAX_AUDIO_BYTES, isSupportedAudioMime, readBodyBounded } from "@/lib/audio";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { workspaceId, userId } = await requireWorkspace(req.headers);
    const { id } = await params;
    const mime = (req.headers.get("content-type") ?? "").trim();
    if (!isSupportedAudioMime(mime))
      return NextResponse.json({ error: "type audio non supporté" }, { status: 415 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_AUDIO_BYTES) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const buf = await readBodyBounded(req, MAX_AUDIO_BYTES);
    if (buf === null) return NextResponse.json({ error: "audio trop gros (16 Mo max)" }, { status: 413 });
    const sp = req.nextUrl.searchParams;
    const r = await createVoiceComment(workspaceId, {
      contentId: id, audio: buf, mime, createdBy: userId,
      quote: sp.get("quote") ?? undefined, prefix: sp.get("prefix") ?? undefined,
      suffix: sp.get("suffix") ?? undefined, section: sp.get("section") ?? undefined,
    });
    return NextResponse.json(r, { status: 201 });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error && e.message.includes("introuvable")) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (e instanceof Error && e.message.includes("audio vide")) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.message.includes("trop gros")) return NextResponse.json({ error: e.message }, { status: 413 });
    if (e instanceof Error && e.message.includes("mime")) return NextResponse.json({ error: e.message }, { status: 415 });
    if (e instanceof Error && e.message.includes("trop long")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
