import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getWatchConfig, updateWatchSettings, redactPublishConfigForClient } from "@/lib/watch";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const { settings } = await getWatchConfig(workspaceId);
    // publish_config est write-only côté navigateur (même statut que
    // gauge_sources.headers) : jamais la valeur en clair au client, même en lecture.
    return NextResponse.json(redactPublishConfigForClient(settings));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();

    // allow-list stricte : topics/style/requireMedia/channelKey/publishConfig
    // uniquement, jamais un spread du body — seules les clés PRÉSENTES du
    // body sont transmises à updateWatchSettings (une absente ne doit pas
    // écraser la valeur existante). Casse camelCase choisie ici, comme le
    // reste des routes JSON multi-mots du repo (ideaId, channelKey,
    // laneCommand…) — edited_text dans POST /api/watch/items/[id] est
    // l'exception historique, pas la règle à suivre.
    const patch: {
      topics?: string[]; style?: string; requireMedia?: boolean;
      channelKey?: string; publishConfig?: Record<string, unknown>;
    } = {};
    if (body.topics !== undefined) patch.topics = body.topics;
    if (body.style !== undefined) patch.style = body.style;
    if (body.requireMedia !== undefined) patch.requireMedia = body.requireMedia;
    if (body.channelKey !== undefined) patch.channelKey = body.channelKey;
    if (body.publishConfig !== undefined) patch.publishConfig = body.publishConfig;

    const settings = await updateWatchSettings(workspaceId, patch);
    // Triptyque de redaction (précédent gauge_sources.headers, fuite rattrapée
    // en revue) : la réponse du PATCH est re-redigée, jamais un écho du body
    // reçu — même la valeur qu'on vient d'écrire ne doit pas ressortir en clair.
    return NextResponse.json(redactPublishConfigForClient(settings));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
