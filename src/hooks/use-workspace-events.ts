"use client";
import { useEffect, useRef } from "react";
import type { WorkspaceEvent } from "@/lib/events";

export function useWorkspaceEvents(onEvent: (e: WorkspaceEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      source = new EventSource("/api/events");
      source.onmessage = (ev) => handler.current(JSON.parse(ev.data));
      source.onerror = () => {
        source?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    }
    connect();
    return () => {
      closed = true;
      source?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
}
