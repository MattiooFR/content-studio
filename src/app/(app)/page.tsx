"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { FunnelLine } from "@/components/cockpit/funnel-line";

type Idea = {
  id: string; title: string; notes: string; status: string;
  tags: string[]; createdAt: string; contentsCount: number; sourcesCount: number;
};

export default function InboxPage() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/ideas");
    if (res.ok) setIdeas(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/ideas", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, notes }),
    });
    if (!res.ok) {
      setError("Échec de la création de l'idée. Réessaie.");
      return;
    }
    setError(null);
    setTitle(""); setNotes(""); load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Idées</h1>
        <p className="mt-1 text-xs text-muted">
          <span className="tabular-nums">{ideas.length}</span> dans l&apos;inbox — les
          tiennes et celles de ton agent via MCP.
        </p>
      </div>

      <SectionCard title="Pipeline">
        <FunnelLine />
      </SectionCard>

      <SectionCard title="Nouvelle idée">
        <form onSubmit={create} className="space-y-3">
          <Input placeholder="Titre" value={title}
            onChange={(e) => setTitle(e.target.value)} required />
          <Textarea placeholder="Notes, angle, sources…" value={notes}
            onChange={(e) => setNotes(e.target.value)} rows={3} />
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit">Ajouter</Button>
          </div>
        </form>
      </SectionCard>

      {ideas.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-10 text-center">
          <p className="text-sm text-muted">
            Aucune idée. Ajoute la première — ou laisse ton agent le faire via MCP.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ideas.map((i) => (
            <a key={i.id} href={`/ideas/${i.id}`}
              className="group flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-4 transition-colors duration-150 hover:border-line-strong">
              <span className="line-clamp-2 text-sm leading-snug font-medium text-ink">
                {i.title}
              </span>
              {i.notes && (
                <span className="line-clamp-2 text-xs leading-relaxed text-muted">
                  {i.notes}
                </span>
              )}
              {i.tags?.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {i.tags.slice(0, 3).map((t) => (
                    <span key={t}
                      className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-muted">
                      {t}
                    </span>
                  ))}
                </span>
              )}
              <span className="mt-auto flex items-center justify-between gap-2 pt-1">
                <StatusBadge kind="idea" value={i.status} />
                <span className="text-[11px] text-faint tabular-nums">
                  {i.sourcesCount ?? 0} source{(i.sourcesCount ?? 0) > 1 ? "s" : ""} ·{" "}
                  {i.contentsCount ?? 0} contenu{(i.contentsCount ?? 0) > 1 ? "s" : ""}
                </span>
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
