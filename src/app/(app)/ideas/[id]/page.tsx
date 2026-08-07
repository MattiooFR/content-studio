"use client";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";

type Idea = { id: string; title: string; notes: string; status: string };
type Content = { id: string; channelId: string; status: string; type: string };
type Channel = { id: string; key: string; name: string };

export default function IdeaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [idea, setIdea] = useState<Idea | null>(null);
  const [contentsList, setContentsList] = useState<Content[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, c] = await Promise.all([
      fetch(`/api/ideas/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/contents?ideaId=${id}`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setIdea(i); setContentsList(c);
  }, [id]);

  useEffect(() => {
    load();
    // les canaux ne changent pas : un fetch suffit
    fetch("/api/channels").then((r) => { if (r.ok) r.json().then(setChannels); });
  }, [load]);

  async function decline(channelKey: string) {
    const res = await fetch("/api/contents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ideaId: id, channelKey }),
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Échec de la création du contenu. Réessaie.");
      return;
    }
    setError(null);
    const { contentId } = await res.json();
    router.push(`/contents/${contentId}`);
  }

  if (!idea) return <p className="text-sm text-muted">Chargement…</p>;
  const channelName = (cid: string) =>
    channels.find((c) => c.id === cid)?.name ?? "canal";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg leading-snug font-semibold tracking-tight">
          {idea.title}
        </h1>
        <StatusBadge kind="idea" value={idea.status} className="mt-1" />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {idea.notes && (
        <SectionCard title="Notes">
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-muted">
            {idea.notes}
          </p>
        </SectionCard>
      )}

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
                <a href={`/contents/${c.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 transition-colors duration-150 hover:border-line-strong">
                  <span className="text-sm font-medium">{channelName(c.channelId)}</span>
                  <StatusBadge kind="content" value={c.status} />
                </a>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
