import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getLane, getLaneMessages } from "@/lib/lanes";
import { runLaneMessage, isLaneBusy, LaneBusyError } from "@/lib/lane-runner";

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const laneId = (await params).id;
    const messages = await getLaneMessages(workspaceId, laneId);
    if (messages === null) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(messages);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const laneId = (await params).id;
    const body = await req.json().catch(() => ({}));
    if (typeof body.body !== "string" || !body.body.trim()) {
      return NextResponse.json({ error: "body requis" }, { status: 400 });
    }

    const lane = await getLane(workspaceId, laneId);
    if (!lane) return NextResponse.json({ error: "not found" }, { status: 404 });

    // Vérif synchrone du verrou juste AVANT l'appel, sans await entre les
    // deux (cf. commentaire de isLaneBusy) : c'est ce qui rend possible un
    // 409 immédiat sans attendre la fin, potentiellement longue, du run.
    if (isLaneBusy(laneId)) {
      return NextResponse.json(
        { error: "une exécution est déjà en cours pour cette lane" },
        { status: 409 }
      );
    }

    // Fire-and-forget volontaire : le flux (chunks, done/error) arrive par
    // SSE (/api/events, événement lane.message) — la réponse HTTP ne doit
    // pas attendre la fin du run.
    runLaneMessage({ workspaceId, laneId, userMessage: body.body }).catch((err) => {
      if (!(err instanceof LaneBusyError)) {
        console.error("lane-runner: échec après acceptation", err);
      }
    });

    return NextResponse.json({ accepted: true });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
