export type WorkspaceEvent =
  | { type: "content.updated"; contentId: string; revisionId: string; state: "current" | "proposed" }
  | { type: "content.status"; contentId: string; status: string }
  | { type: "idea.created"; ideaId: string };

type Handler = (e: WorkspaceEvent) => void;

// globalThis : next dev recharge les modules, les abonnés SSE doivent survivre.
const g = globalThis as unknown as { __csBus?: Map<string, Set<Handler>> };
const subscribers = g.__csBus ?? new Map<string, Set<Handler>>();
g.__csBus = subscribers;

export const bus = {
  publish(workspaceId: string, e: WorkspaceEvent): void {
    for (const fn of subscribers.get(workspaceId) ?? []) {
      try { fn(e); } catch { /* un abonné cassé ne bloque pas les autres */ }
    }
  },
  subscribe(workspaceId: string, fn: Handler): () => void {
    if (!subscribers.has(workspaceId)) subscribers.set(workspaceId, new Set());
    subscribers.get(workspaceId)!.add(fn);
    return () => subscribers.get(workspaceId)?.delete(fn);
  },
};
