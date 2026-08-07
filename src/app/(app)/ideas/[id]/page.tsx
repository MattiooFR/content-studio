"use client";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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

  if (!idea) return <p>Chargement…</p>;
  const channelName = (cid: string) =>
    channels.find((c) => c.id === cid)?.name ?? "canal";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{idea.title}</h1>
        {idea.notes && (
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{idea.notes}</p>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        {channels.map((c) => (
          <Button key={c.id} variant="outline" onClick={() => decline(c.key)}>
            Décliner sur {c.name}
          </Button>
        ))}
      </div>
      <ul className="space-y-2">
        {contentsList.map((c) => (
          <li key={c.id}>
            <a href={`/contents/${c.id}`}
              className="flex items-center justify-between rounded-lg border p-3 hover:bg-accent">
              <span>{channelName(c.channelId)}</span>
              <Badge variant="outline">{c.status}</Badge>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
