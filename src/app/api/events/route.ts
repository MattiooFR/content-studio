import { NextRequest, NextResponse } from "next/server";
import { requireWorkspace, TenantError } from "@/lib/tenant";
import { bus } from "@/lib/events";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { workspaceId } = await requireWorkspace(req.headers);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      start(controller) {
        const send = (s: string) => {
          try { controller.enqueue(encoder.encode(s)); } catch { /* flux fermé */ }
        };
        send(": connected\n\n");
        const unsubscribe = bus.subscribe(workspaceId, (e) =>
          send(`data: ${JSON.stringify(e)}\n\n`)
        );
        const ping = setInterval(() => send(": ping\n\n"), 25_000);
        req.signal.addEventListener("abort", () => {
          unsubscribe();
          clearInterval(ping);
          try { controller.close(); } catch { /* déjà fermé */ }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    if (e instanceof TenantError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    throw e;
  }
}
