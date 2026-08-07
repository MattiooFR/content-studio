"use client";
import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";

type Idea = { id: string; title: string; notes: string; status: string };
type Content = { id: string; channelId: string; status: string; type: string };
type Channel = { id: string; key: string; name: string };
type Source = {
  id: string; kind: string; ref: string; title: string;
  extractedText: string; status: string;
};

export default function IdeaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [idea, setIdea] = useState<Idea | null>(null);
  const [contentsList, setContentsList] = useState<Content[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sourcesList, setSourcesList] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, c, s] = await Promise.all([
      fetch(`/api/ideas/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/contents?ideaId=${id}`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/ideas/${id}/sources`).then((r) => (r.ok ? r.json() : [])),
    ]);
    setIdea(i); setContentsList(c); setSourcesList(s);
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
    const res = await fetch(`/api/ideas/${id}/sources`, {
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
