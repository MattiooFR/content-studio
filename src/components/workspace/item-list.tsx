"use client";
// Colonne de gauche de la salle de tri : création d'idée en tête, puis une
// ligne par item du bucket courant. Le scroll vit ICI (`overflow-y-auto` sur
// la zone des lignes), jamais sur la page : l'en-tête et le formulaire restent
// visibles pendant qu'on descend la liste.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceItems, type WorkspaceItem } from "@/components/workspace/items-provider";
import { stageOf, BUCKET_LABELS, STAGE_LABELS, type Bucket, type Stage } from "@/lib/stage";
import { cn } from "@/lib/utils";

// Teintes alignées sur StatusBadge (contrat W1) : un statut = une couleur dans
// toute l'app. Les étapes sont un concept nouveau (dérivé), d'où des classes
// locales — mais elles reprennent exactement les tons du badge.
const STAGE_TONE: Record<Stage, string> = {
  proposed: "border-line bg-raised text-muted",
  writing: "border-accent/40 bg-accent-soft text-accent",
  review: "border-warning/30 bg-warning/10 text-warning",
  ready: "border-success/30 bg-success/10 text-success",
  published: "border-success/30 bg-success/10 text-success",
  discarded: "border-line bg-raised text-faint",
};

const EMPTY_MESSAGE: Record<Bucket, string> = {
  todo: "Rien à traiter 🎉",
  writing: "Aucune rédaction en cours.",
  published: "Rien de publié pour l'instant.",
  discarded: "Aucun élément écarté.",
};

// Date relative courte, sans dépendance : « il y a 3 j », « hier », « à l'instant ».
const RTF = new Intl.RelativeTimeFormat("fr", { numeric: "auto", style: "narrow" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800],
  ["day", 86_400], ["hour", 3_600], ["minute", 60],
];
function relativeDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = (t - Date.now()) / 1000; // négatif = passé
  const abs = Math.abs(diff);
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return RTF.format(Math.round(diff / secs), unit);
  }
  return "à l'instant";
}

function StagePill({ stage }: { stage: Stage }) {
  return (
    <span className={cn(
      "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-widest whitespace-nowrap uppercase",
      STAGE_TONE[stage]
    )}>
      {STAGE_LABELS[stage]}
    </span>
  );
}

export function ItemList({ items, bucket, loaded, selectedId, onSelect }: {
  items: WorkspaceItem[];
  bucket: Bucket;
  loaded: boolean;
  selectedId: string | null;
  onSelect: (ideaId: string) => void;
}) {
  const { reload } = useWorkspaceItems();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Repris de l'ancienne home (POST /api/ideas) : on rafraîchit le provider
  // partagé — compteurs de la sidebar inclus — puis on ouvre l'idée créée.
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, notes }),
      });
      if (!res.ok) {
        setError("Échec de la création de l'idée. Réessaie.");
        return;
      }
      const created = (await res.json()) as { id?: string };
      setError(null);
      setTitle(""); setNotes(""); setOpen(false);
      reload();
      // Une idée neuve n'a aucun contenu : `onSelect` ouvrira sa fiche idée.
      if (created?.id) onSelect(created.id);
    } catch {
      setError("Échec de la création de l'idée. Réessaie.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <p className="min-w-0 truncate text-xs text-muted">
          <span className="tabular-nums text-ink">{items.length}</span>{" "}
          {BUCKET_LABELS[bucket].toLowerCase()}
        </p>
        <Button size="xs" variant={open ? "ghost" : "default"}
          aria-expanded={open}
          onClick={() => { setOpen(!open); setError(null); }}>
          {open ? "Annuler" : "Nouvelle idée"}
        </Button>
      </div>

      {open && (
        <form onSubmit={create} className="grid gap-2 border-b border-line bg-raised/40 px-4 py-3">
          <Input autoFocus placeholder="Titre" value={title}
            onChange={(e) => setTitle(e.target.value)} required />
          <Textarea placeholder="Notes, angle, sources…" value={notes}
            onChange={(e) => setNotes(e.target.value)} rows={3} />
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
              {submitting ? "Ajout…" : "Ajouter"}
            </Button>
          </div>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <p className="px-4 py-10 text-center text-sm text-muted">Chargement…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">{EMPTY_MESSAGE[bucket]}</p>
        ) : (
          <ul aria-label={BUCKET_LABELS[bucket]}>
            {items.map((it) => {
              const stage = stageOf(it.status, it.contents, it.lastJobStatus);
              const active = it.id === selectedId;
              const sources = it.sourcesCount ?? 0;
              return (
                <li key={it.id}>
                  <button type="button" onClick={() => onSelect(it.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col items-start gap-1.5 border-b border-line px-4 py-3 text-left transition-colors duration-150",
                      active
                        ? "bg-accent-soft shadow-[inset_2px_0_0_var(--color-accent)]"
                        : "hover:bg-raised"
                    )}>
                    <span className="line-clamp-2 text-sm leading-snug font-medium text-ink">
                      {it.title}
                    </span>
                    <span className="flex w-full min-w-0 items-center gap-2">
                      <StagePill stage={stage} />
                      <span className="min-w-0 truncate text-[11px] text-faint tabular-nums">
                        {sources} source{sources > 1 ? "s" : ""} · {relativeDate(it.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
