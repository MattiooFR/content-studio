import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { createGaugeSource, getGaugesState, redactHeadersForClient } from "@/lib/gauges";

const KINDS = ["quota", "cost"] as const;

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    return NextResponse.json(await getGaugesState(workspaceId, { refresh }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();

    if (typeof body.name !== "string" || !body.name.trim())
      return NextResponse.json({ error: "name requis" }, { status: 400 });
    if (typeof body.url !== "string")
      return NextResponse.json({ error: "url requise" }, { status: 400 });
    if (typeof body.kind !== "string" || !KINDS.includes(body.kind as never))
      return NextResponse.json({ error: "kind invalide (quota|cost attendu)" }, { status: 400 });

    // allow-list stricte : name/url/headers/kind uniquement, jamais un spread du body.
    const source = await createGaugeSource(workspaceId, {
      name: body.name,
      url: body.url,
      headers: body.headers,
      kind: body.kind as "quota" | "cost",
    });
    // Même durcissement que GET (getGaugesState) et PATCH /api/gauges/[id] :
    // createGaugeSource renvoie la ligne insérée telle quelle, headers en
    // clair inclus (c'est là que vit un x-api-key) — la réponse au client
    // doit passer par redactHeadersForClient, sinon la création fuit
    // exactement ce que GET/PATCH protègent déjà. Voir redactHeadersForClient
    // dans gauges.ts.
    return NextResponse.json(redactHeadersForClient(source));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
