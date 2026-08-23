"use client";
import { useCallback, useEffect, useState } from "react";
import { SectionCard } from "@/components/cockpit/section-card";
import { JobStatus } from "@/components/cockpit/job-status";
import { Button } from "@/components/ui/button";
import { useJobs } from "@/hooks/use-jobs";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type Pub = {
  id: string; target: string; externalId: string; url: string; syncedAt: string | null;
  publishedAt: string | null; lastError: string | null; stale: boolean;
};

function ago(iso: string | null): string {
  if (!iso) return "jamais";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.floor(h / 24)} j`;
}

/** Absente tant qu'aucune publication n'existe (le parent ne la monte qu'alors). */
export function PublicationCard({ contentId, bodyKey }: { contentId: string; bodyKey: string }) {
  const [pubs, setPubs] = useState<Pub[]>([]);
  const jobs = useJobs("content", contentId);
  const syncJob = jobs.latest("sync");
  const load = useCallback(async () => {
    const r = await fetch(`/api/contents/${contentId}/publications`);
    if (r.ok) setPubs(await r.json());
  }, [contentId]);
  useEffect(() => { load(); }, [load, bodyKey]);
  useWorkspaceEvents((e) => {
    const touchesContent =
      (e.type === "content.updated" && e.contentId === contentId) ||
      (e.type === "job.updated" && e.targetType === "content" && e.targetId === contentId);
    if (touchesContent) load();
  });
  if (pubs.length === 0) return null;
  return (
    <SectionCard title="Publication">
      <ul className="space-y-3">
        {pubs.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{p.target}</span>
            {p.url && <a className="underline" href={p.url} target="_blank" rel="noreferrer">voir</a>}
            {p.lastError ? (
              <span className="text-danger">échec : {p.lastError}</span>
            ) : p.stale ? (
              <span className="text-warning">modifications en attente de sync</span>
            ) : (
              <span className="text-muted">synchronisé {ago(p.syncedAt)}</span>
            )}
            {(p.stale || p.lastError) && !(syncJob && (syncJob.status === "queued" || syncJob.status === "running")) && (
              <Button variant="outline" onClick={() => jobs.create("sync", { publication_id: p.id, target: p.target })}>
                Re-synchroniser
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-3"><JobStatus job={syncJob} onRetry={jobs.retry} onCancel={jobs.cancel} renderDone={() => "Synchronisé"} /></div>
      {jobs.error && <p className="mt-2 text-sm text-danger">{jobs.error}</p>}
    </SectionCard>
  );
}
