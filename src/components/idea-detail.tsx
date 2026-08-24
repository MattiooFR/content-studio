"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";
import { MarkdownView } from "@/components/markdown-view";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { JobStatus } from "@/components/cockpit/job-status";
import { useJobs } from "@/hooks/use-jobs";
import type { WorkspaceItemRef } from "@/lib/workspace-url";

type Idea = { id: string; title: string; notes: string; status: string };
type Content = { id: string; channelId: string; status: string; type: string };
type Channel = { id: string; key: string; name: string };
type Source = {
  id: string; kind: string; ref: string; title: string;
  extractedText: string; status: string;
};

export function IdeaDetail({ ideaId, onOpenItem }: { ideaId: string; onOpenItem: (ref: WorkspaceItemRef) => void }) {
  const [idea, setIdea] = useState<Idea | null>(null);
  const [contentsList, setContentsList] = useState<Content[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sourcesList, setSourcesList] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const jobs = useJobs("idea", ideaId);
  const writeJob = jobs.latest("write");
  const writeActive = writeJob?.status === "queued" || writeJob?.status === "running";
  const [writeChannel, setWriteChannel] = useState<string>("");
  // canal par défaut : le dernier choisi dans ce navigateur, sinon le premier
  useEffect(() => {
    if (!channels.length || writeChannel) return;
    let remembered: string | null = null;
    try { remembered = localStorage.getItem("cs.writeChannel"); } catch { /* stockage indisponible */ }
    setWriteChannel(channels.some((c) => c.key === remembered) ? remembered! : channels[0].key);
  }, [channels, writeChannel]);

  async function requestWrite() {
    try { localStorage.setItem("cs.writeChannel", writeChannel); } catch { /* ignoré */ }
    await jobs.create("write", { channel_key: writeChannel });
    load(); // l'idée passe in_progress
  }

  const load = useCallback(async () => {
    const [i, c, s] = await Promise.all([
      fetch(`/api/ideas/${ideaId}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/contents?ideaId=${ideaId}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/ideas/${ideaId}/sources`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setIdea(i); setContentsList(c); setSourcesList(s);
  }, [ideaId]);

  useEffect(() => {
    load();
    // les canaux ne changent pas : un fetch suffit
    fetch("/api/channels").then((r) => { if (r.ok) r.json().then(setChannels); });
  }, [load]);

  async function decline(channelKey: string) {
    const res = await fetch("/api/contents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ideaId, channelKey }),
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Échec de la création du contenu. Réessaie.");
      return;
    }
    setError(null);
    const { contentId } = await res.json();
    onOpenItem({ type: "content", id: contentId });
  }

  async function addSourceSubmit(e: React.FormEvent) {
    e.preventDefault();
    const url = sourceUrl.trim();
    const text = sourceText.trim();
    // deux modes, un seul bouton : l'URL prime si les deux champs sont
    // remplis (le texte devient alors un extrait attaché à cette URL).
    const kind = url ? "url" : "text";
    const ref = url || text;
    if (!ref) {
      setSourceError("Renseigne une URL ou colle du texte.");
      return;
    }
    const res = await fetch(`/api/ideas/${ideaId}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind, ref,
        rawExcerpt: url && text ? text : undefined,
      }),
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setSourceError(message ?? "Échec de l'ajout de la source. Réessaie.");
      return;
    }
    setSourceError(null);
    setSourceUrl(""); setSourceText("");
    load();
  }

  if (!idea) return <p className="text-sm text-muted">Chargement…</p>;
  const channelName = (cid: string) =>
    channels.find((c) => c.id === cid)?.name ?? "canal";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg leading-snug font-semibold tracking-tight">
          {idea.title}
        </h2>
        <StatusBadge kind="idea" value={idea.status} className="mt-1" />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {idea.notes && (
        <SectionCard title="Notes">
          <MarkdownView markdown={idea.notes} className="text-sm leading-relaxed" />
        </SectionCard>
      )}

      <SectionCard
        title="Sources"
        badge={
          <span className="text-[11px] text-faint tabular-nums">
            {sourcesList.length}
          </span>
        }
      >
        <form onSubmit={addSourceSubmit} className="space-y-2">
          <Input placeholder="https://…" value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)} />
          <Textarea placeholder="…ou colle un texte" value={sourceText}
            onChange={(e) => setSourceText(e.target.value)} rows={3} />
          {sourceError && <p className="text-sm text-danger">{sourceError}</p>}
          <div className="flex justify-end">
            <Button type="submit">Ajouter</Button>
          </div>
        </form>

        {sourcesList.length === 0 ? (
          <p className="mt-4 text-sm text-muted">
            Aucune source déposée — une URL ou un texte collé.
          </p>
        ) : (
          <ul className="mt-4 space-y-2">
            {sourcesList.map((s) => {
              const extractable = s.status === "extracted";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() =>
                      extractable && setOpenSourceId(openSourceId === s.id ? null : s.id)
                    }
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-left transition-colors duration-150 hover:border-line-strong"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {s.title || s.ref}
                    </span>
                    <StatusBadge
                      kind="source"
                      value={s.status}
                      className={s.status === "pending" ? "animate-pulse" : undefined}
                    />
                  </button>
                  {extractable && openSourceId === s.id && (
                    <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-5 whitespace-pre-wrap">
                      {s.extractedText.slice(0, 500)}
                      {s.extractedText.length > 500 ? "…" : ""}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Rédiger avec l'agent">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={writeChannel}
            onChange={(e) => setWriteChannel(e.target.value)}
            disabled={writeActive || channels.length === 0}
            className="rounded-lg border border-line bg-raised px-2 py-1.5 text-sm"
          >
            {channels.map((c) => <option key={c.id} value={c.key}>{c.name}</option>)}
          </select>
          <Button onClick={requestWrite} disabled={writeActive || !writeChannel}>Rédiger</Button>
          <JobStatus
            job={writeJob}
            onRetry={jobs.retry}
            onCancel={jobs.cancel}
            renderDone={(j) => {
              const cid = typeof j.result.content_id === "string" ? j.result.content_id : null;
              return cid
                ? <button type="button" className="underline" onClick={() => onOpenItem({ type: "content", id: cid })}>Brouillon prêt → ouvrir</button>
                : "Terminé";
            }}
          />
        </div>
        {jobs.error && <p className="mt-2 text-sm text-danger">{jobs.error}</p>}
        <p className="mt-2 text-xs text-faint">
          Un worker branché en MCP prend la demande, enquête, rédige, et dépose un brouillon en relecture.
        </p>
      </SectionCard>

      <SectionCard title="Décliner sur un canal">
        <div className="flex flex-wrap gap-2">
          {channels.map((c) => (
            <Button key={c.id} variant="outline" onClick={() => decline(c.key)}>
              {c.name}
            </Button>
          ))}
          {channels.length === 0 && (
            <p className="text-sm text-muted">Aucun canal configuré.</p>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Contenus"
        badge={
          <span className="text-[11px] text-faint tabular-nums">
            {contentsList.length}
          </span>
        }
      >
        {contentsList.length === 0 ? (
          <p className="text-sm text-muted">
            Aucun contenu — décline l&apos;idée sur un canal pour commencer.
          </p>
        ) : (
          <ul className="space-y-2">
            {contentsList.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onOpenItem({ type: "content", id: c.id })}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-left transition-colors duration-150 hover:border-line-strong">
                  <span className="text-sm font-medium">{channelName(c.channelId)}</span>
                  <StatusBadge kind="content" value={c.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
