"use client";
// Vue B de la salle de tri : 5 colonnes par étape active (spec §3 — `discarded`
// n'a pas de colonne, il reste accessible via le bucket « Écartés » de la vue
// liste). Le board ignore TOUJOURS `bucket` : contrairement à la liste, il ne
// filtre rien, il montre le pipeline entier. Cliquer une carte délègue au
// shell (`onSelect` = `selectIdea` de page.tsx) — même règle « contenu le plus
// avancé » que la liste, aucune duplication de logique ici.
import { useMemo } from "react";
import type { WorkspaceItem } from "@/components/workspace/items-provider";
import { StagePill, relativeDate } from "@/components/workspace/item-list";
import { stageOf, STAGE_LABELS, STAGE_DOT, type Stage } from "@/lib/stage";
import { cn } from "@/lib/utils";

const COLUMNS: Stage[] = ["proposed", "writing", "review", "ready", "published"];

function BoardCard({ item, stage, active, onSelect }: {
  item: WorkspaceItem;
  stage: Stage;
  active: boolean;
  onSelect: (ideaId: string) => void;
}) {
  const sources = item.sourcesCount ?? 0;
  return (
    <li>
      <button type="button" onClick={() => onSelect(item.id)}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full flex-col items-start gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150",
          active
            ? "border-accent/40 bg-accent-soft shadow-[inset_2px_0_0_var(--color-accent)]"
            : "border-line bg-bg hover:bg-raised"
        )}>
        <span className="line-clamp-2 text-sm leading-snug font-medium text-ink">
          {item.title}
        </span>
        <span className="flex w-full min-w-0 items-center gap-2">
          <StagePill stage={stage} />
          <span className="min-w-0 truncate text-[11px] text-faint tabular-nums">
            {sources} source{sources > 1 ? "s" : ""} · {relativeDate(item.createdAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

function BoardColumn({ stage, items, selectedId, onSelect }: {
  stage: Stage;
  items: WorkspaceItem[];
  selectedId: string | null;
  onSelect: (ideaId: string) => void;
}) {
  return (
    <div className="flex flex-col rounded-xl border border-line bg-raised/30">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className={cn("size-2 shrink-0 rounded-full", STAGE_DOT[stage])} aria-hidden />
        <span className="text-xs font-semibold tracking-wide text-ink">{STAGE_LABELS[stage]}</span>
        <span className="ml-auto text-[11px] text-faint tabular-nums">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-2 p-2">
        {items.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-faint">
            {stage === "writing" ? "Le worker est libre" : "—"}
          </li>
        ) : (
          items.map((it) => (
            <BoardCard key={it.id} item={it} stage={stage}
              active={it.id === selectedId} onSelect={onSelect} />
          ))
        )}
      </ul>
    </div>
  );
}

export function Board({ items, onSelect, selectedId }: {
  items: WorkspaceItem[];
  onSelect: (ideaId: string) => void;
  selectedId: string | null;
}) {
  // Partitionné une seule fois par changement d'items — pas par colonne.
  const columns = useMemo(() => {
    const map: Record<Stage, WorkspaceItem[]> = {
      proposed: [], writing: [], review: [], ready: [], published: [], discarded: [],
    };
    for (const it of items) {
      const stage = stageOf(it.status, it.contents, it.lastJobStatus);
      if (stage === "discarded") continue; // pas de colonne (spec §3)
      map[stage].push(it);
    }
    return map;
  }, [items]);

  return (
    <div className="overflow-x-auto p-4">
      <div className="grid min-w-[900px] grid-cols-5 gap-3">
        {COLUMNS.map((stage) => (
          <BoardColumn key={stage} stage={stage} items={columns[stage]}
            selectedId={selectedId} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
