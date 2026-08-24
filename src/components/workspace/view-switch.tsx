"use client";
// Segmented control liste ⇄ board, en tête de la colonne centrale. Reprend
// exactement le style pilule du sélecteur de statut de la fiche contenu
// (content-detail.tsx : `rounded-full border border-line bg-raised p-0.5`) —
// un contrôle à deux états = une seule apparence dans toute l'app.
import type { WorkspaceState } from "@/lib/workspace-url";

const OPTIONS: { value: WorkspaceState["view"]; label: string }[] = [
  { value: "list", label: "Liste" },
  { value: "board", label: "Board" },
];

export function ViewSwitch({ view, onChange }: {
  view: WorkspaceState["view"];
  onChange: (view: WorkspaceState["view"]) => void;
}) {
  return (
    <div role="group" aria-label="Vue"
      className="flex items-center gap-1 rounded-full border border-line bg-raised p-0.5">
      {OPTIONS.map(({ value, label }) => (
        <button key={value} type="button" aria-pressed={view === value}
          onClick={() => onChange(value)}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wider uppercase transition-colors duration-150 ${
            view === value ? "bg-accent-soft text-accent" : "text-muted hover:text-ink"
          }`}>
          {label}
        </button>
      ))}
    </div>
  );
}
