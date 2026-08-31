"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export type JobRow = {
  id: string; kind: string; status: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: Record<string, unknown>; result: Record<string, unknown>; error: string | null;
  attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
};

/**
 * Les jobs d'une cible, tenus à jour par SSE (job.updated) — jamais de polling.
 * `latest(kind)` = le plus récent de ce kind (la liste arrive plus récents d'abord).
 */
export function useJobs(targetType: "idea" | "content" | "comment" | "source", targetId: string) {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/jobs?target_type=${targetType}&target_id=${targetId}`);
    if (res.ok) setJobs(await res.json());
  }, [targetType, targetId]);
  useEffect(() => { refresh(); }, [refresh]);
  useWorkspaceEvents((e) => {
    if (e.type === "job.updated" && e.targetType === targetType && e.targetId === targetId) refresh();
  });

  const create = useCallback(async (
    kind: string, payload?: Record<string, unknown>, opts?: { coalesce?: boolean },
  ) => {
    setError(null);
    const res = await fetch("/api/jobs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, target_type: targetType, target_id: targetId, payload,
        coalesce: opts?.coalesce,
      }),
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Échec de la demande. Réessaie.");
      return null;
    }
    await refresh();
    return (await res.json()).job as JobRow;
  }, [targetType, targetId, refresh]);

  const act = useCallback(async (id: string, action: "retry" | "cancel") => {
    setError(null);
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: "POST" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? `Échec (${action}). Réessaie.`);
    }
    await refresh();
  }, [refresh]);

  const latest = useCallback((kind: string) => jobs.find((j) => j.kind === kind) ?? null, [jobs]);
  const api = useMemo(() => ({
    jobs, latest, refresh, create, error,
    retry: (id: string) => act(id, "retry"),
    cancel: (id: string) => act(id, "cancel"),
  }), [jobs, latest, refresh, create, error, act]);
  return api;
}
