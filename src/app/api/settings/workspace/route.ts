import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { getWorkspaceSettings, setLaneCommand } from "@/lib/lanes";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    return NextResponse.json(await getWorkspaceSettings(workspaceId));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json().catch(() => ({}));
    // allow-list stricte : laneCommand uniquement, jamais un spread du body —
    // c'est la commande shell qui tourne sur la machine de l'utilisateur au
    // prochain message de lane, aucun autre champ n'a de raison d'être ici.
    if (typeof body.laneCommand !== "string") {
      return NextResponse.json({ error: "laneCommand (chaîne) requis" }, { status: 400 });
    }
    const row = await setLaneCommand(workspaceId, body.laneCommand);
    return NextResponse.json(row);
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (e instanceof Error) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
