"use client";
import { useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/status-badge";

export type Revision = {
  id: string; body: string; authorType: "agent" | "user";
  authorLabel: string; state: string; createdAt: string;
};

// Une révision écrite DEPUIS une conversation de lane (Task W11 — authorLabel
// posé par applyContentUpdate quand un lane_id/laneId est fourni, cf.
// src/lib/contents.ts) porte le tag "lane:<uuid>". Détecté ici plutôt que
// dans authorType/authorLabel séparés : c'est le SEUL format qui encode
// l'id de la lane, pas de colonne dédiée.
const LANE_LABEL_RE = /^lane:([0-9a-fA-F-]{36})$/;

export function RevisionsPanel({ revisions, currentBody, onRestore, onOpenLane }: {
  revisions: Revision[]; currentBody: string;
  // superseded uniquement — une "proposed" a déjà son propre bandeau
  // accepter/rejeter (ProposedBanner) et une "current" n'a rien à restaurer.
  onRestore: (rev: Revision) => void;
  /** Optionnel : si fourni, une révision lane:<id> affiche "ouvrir la conversation". */
  onOpenLane?: (laneId: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <details className="rounded-xl border border-line bg-surface p-5 transition-colors duration-150 hover:border-line-strong">
      <summary className="cursor-pointer text-sm font-semibold select-none">
        Révisions <span className="font-normal text-muted tabular-nums">({revisions.length})</span>
      </summary>
      <ul className="mt-4 space-y-2">
        {revisions.map((r) => {
          const laneMatch = r.authorLabel.match(LANE_LABEL_RE);
          return (
          <li key={r.id} className="text-sm">
            <div className="flex w-full items-center gap-2">
              <button className="flex flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                <StatusBadge kind="content" value={r.state} />
                <span>{r.authorType === "agent" ? `agent (${r.authorLabel})` : "toi"}</span>
                <span className="text-xs text-faint tabular-nums">
                  {new Date(r.createdAt).toLocaleString("fr-FR")}
                </span>
              </button>
              {laneMatch && onOpenLane && (
                <Button size="sm" variant="outline" onClick={() => onOpenLane(laneMatch[1])}>
                  Ouvrir la conversation
                </Button>
              )}
              {r.state === "superseded" && (
                <Button size="sm" variant="outline" onClick={() => onRestore(r)}>
                  Restaurer
                </Button>
              )}
            </div>
            {openId === r.id && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-5">
                {diffLines(r.body, currentBody).map((part, i) => (
                  <span key={i}
                    className={part.added ? "block bg-success/15" : part.removed ? "block bg-danger/15 text-muted line-through" : "block"}>
                    {part.value}
                  </span>
                ))}
              </pre>
            )}
          </li>
          );
        })}
      </ul>
    </details>
  );
}
