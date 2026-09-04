// Un run de lane (Task W10) : un chunk de texte assistant, la fin propre du
// process (exit 0), ou une erreur (exit ≠ 0 / process introuvable). Vécu
// par lane-runner.ts, rendu tel quel par le drawer de chat (W11).
export type LaneRunEvent =
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type WorkspaceEvent =
  | { type: "content.updated"; contentId: string; revisionId: string; state: "current" | "proposed" }
  | { type: "content.status"; contentId: string; status: string }
  | { type: "idea.created"; ideaId: string }
  | { type: "lane.message"; laneId: string; event: LaneRunEvent }
  // vague « cockpit agent » : chaque transition d'un job (création incluse)
  | { type: "job.updated"; jobId: string; kind: string; targetType: "idea" | "content" | "comment" | "source" | "dictation"; targetId: string; status: string }
  // vague « sources & extraction » : transitions d'une source (pending → extracted/failed, réessai)
  | { type: "source.updated"; sourceId: string; ideaId: string; status: string }
  // création, mise à jour, ou changement de transcription d'un commentaire
  | { type: "comment.updated"; contentId: string; commentId: string; status: string; transcription: string }
  // module veille : dépôt (itemId absent = lot, l'UI refetch) ou décision
  | { type: "watch.updated"; itemId?: string; status?: string }
  // vague « dictée partout » : transitions d'une dictée (pending → done/failed,
  // réessai, consommation par le champ, suppression → "deleted")
  | { type: "dictation.updated"; dictationId: string; fieldKey: string; status: string };

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
