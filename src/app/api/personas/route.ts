import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { listPersonas, createPersona } from "@/lib/personas";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    return NextResponse.json(await listPersonas(workspaceId));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const body = await req.json();
    if (!body.name) return NextResponse.json({ error: "name requis" }, { status: 400 });
    return NextResponse.json(await createPersona(workspaceId, {
      name: body.name,
      voice: body.voice,
      audience: body.audience,
      language: body.language,
    }));
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
