"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/status-badge";
import type { JobRow } from "@/hooks/use-jobs";

const WAITING_AGENT_AFTER_MS = 2 * 60_000;

function elapsed(from: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

export function JobStatus({ job, onRetry, onCancel, renderDone }: {
  job: JobRow | null;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  renderDone?: (job: JobRow) => React.ReactNode;
}) {
  // re-rendu toutes les 15 s pour « En cours… depuis N » et « en attente d'un agent »
  const [, tick] = useState(0);
  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, [job]);
  if (!job) return null;

  if (job.status === "queued") {
    const waiting = Date.now() - new Date(job.createdAt).getTime() > WAITING_AGENT_AFTER_MS;
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="queued" className="animate-pulse" />
        {waiting ? "En attente d'un agent…" : "Demande enregistrée"}
        <Button variant="outline" onClick={() => onCancel(job.id)}>Annuler</Button>
      </span>
    );
  }
  if (job.status === "running") {
    return (
      <span className="flex items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="running" className="animate-pulse" />
        En cours… depuis {elapsed(job.startedAt ?? job.createdAt)}
      </span>
    );
  }
  if (job.status === "failed") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs">
        <StatusBadge kind="job" value="failed" />
        <span className="text-danger">Échec : {job.error}</span>
        <Button variant="outline" onClick={() => onRetry(job.id)}>Réessayer</Button>
      </span>
    );
  }
  if (job.status === "done") {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <StatusBadge kind="job" value="done" />
        {renderDone ? renderDone(job) : "Terminé"}
      </span>
    );
  }
  return <StatusBadge kind="job" value={job.status} />;
}
