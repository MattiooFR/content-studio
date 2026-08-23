import { NextRequest, NextResponse } from "next/server";
import { resolveMcpToken } from "@/lib/tenant";
import { getJob } from "@/lib/jobs";
import { getCommentAudio } from "@/lib/comments";

/**
 * La seule route REST binaire ouverte au token MCP : l'audio du commentaire
 * visé par un job transcribe du workspace du token. 404 pour tout le reste
 * (job d'un autre workspace, pas un transcribe, audio déjà purgé).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveMcpToken(req.headers.get("authorization"));
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const job = await getJob(auth.workspaceId, (await params).id);
  if (!job || job.kind !== "transcribe" || job.targetType !== "comment")
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const audio = await getCommentAudio(auth.workspaceId, job.targetId);
  if (!audio) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(audio.bytes), {
    status: 200,
    headers: { "content-type": audio.mime, "content-length": String(audio.bytes.length), "cache-control": "no-store" },
  });
}
