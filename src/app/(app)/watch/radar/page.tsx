"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { SectionCard } from "@/components/cockpit/section-card";
import { Button } from "@/components/ui/button";
import { WatchSourcePreview, nomAuteurAffiche, type WatchItemDTO } from "@/components/watch/watch-card";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export default function WatchRadarPage() {
  const [items, setItems] = useState<WatchItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Même garde d'ordre que /watch (Task 7, fix round 1) : plusieurs load()
  // rapprochés (watch.updated, le `await load()` après create_idea) peuvent
  // résoudre dans le désordre — seul le plus récent est appliqué.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const res = await fetch("/api/watch/items?status=pool");
      if (res.ok) {
        const data = (await res.json()) as { items: WatchItemDTO[] };
        if (seq === loadSeq.current) setItems(data.items);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // La route purge et borne elle-même à 7 j : un dépôt du worker, une
  // création d'idée depuis un autre onglet, ou la purge paresseuse peuvent
  // tous périmer la liste affichée.
  useWorkspaceEvents((e) => {
    if (e.type === "watch.updated") load();
  });

  function setBusy(id: string, v: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setError(id: string, msg: string | null) {
    setErrors((prev) => {
      if (msg == null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: msg };
    });
  }

  async function creerIdee(id: string) {
    setBusy(id, true);
    setError(id, null);
    try {
      const res = await fetch(`/api/watch/items/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create_idea" }),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(id, payload?.error ?? "Échec de la création de l'idée. Réessaie.");
        return;
      }
      await load();
    } finally {
      setBusy(id, false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Radar — signaux détectés</h1>
        <p className="mt-1 text-xs text-muted">
          Tous les signaux des 7 derniers jours, triés par score. Repêche ceux qui méritent une idée.
        </p>
      </div>

      <SectionCard
        title="Signaux"
        badge={<span className="text-[11px] text-faint tabular-nums">{items.length}</span>}
      >
        {loading ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">
            Aucun signal pour l&apos;instant — le radar se remplit au fil des dépôts du worker.
          </p>
        ) : (
          <ul className="space-y-4">
            {items.map((item) => (
              <li key={item.id}>
                <RadarCard
                  item={item}
                  busy={busyIds.has(item.id)}
                  error={errors[item.id] ?? null}
                  onCreateIdea={creerIdee}
                />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function RadarCard({
  item,
  busy,
  error,
  onCreateIdea,
}: {
  item: WatchItemDTO;
  busy: boolean;
  error: string | null;
  onCreateIdea: (id: string) => void;
}) {
  const nomAffiche = nomAuteurAffiche(item);

  return (
    <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 lg:grid-cols-[1fr_auto] lg:items-start">
      <WatchSourcePreview item={item} />

      <div className="flex flex-row items-center gap-2 lg:flex-col lg:items-end">
        {error && (
          <p role="alert" className="text-xs text-danger lg:text-right">
            {error}
          </p>
        )}
        {item.ideaId ? (
          <span className="inline-flex shrink-0 items-center rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-xs font-medium whitespace-nowrap text-success">
            Idée créée
          </span>
        ) : (
          <Button
            type="button"
            onClick={() => onCreateIdea(item.id)}
            disabled={busy}
            aria-label={`Créer une idée à partir de la proposition de ${nomAffiche}`}
          >
            {busy ? "…" : "Créer une idée"}
          </Button>
        )}
      </div>
    </div>
  );
}
