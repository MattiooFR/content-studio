"use client";
import { useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/cockpit/status-badge";

export type Revision = {
  id: string; body: string; authorType: "agent" | "user";
  authorLabel: string; state: string; createdAt: string;
};

export function RevisionsPanel({ revisions, currentBody, onRestore }: {
  revisions: Revision[]; currentBody: string;
  // superseded uniquement — une "proposed" a déjà son propre bandeau
  // accepter/rejeter (ProposedBanner) et une "current" n'a rien à restaurer.
  onRestore: (rev: Revision) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <details className="rounded-xl border border-line bg-surface p-5 transition-colors duration-150 hover:border-line-strong">
      <summary className="cursor-pointer text-sm font-semibold select-none">
        Révisions <span className="font-normal text-muted tabular-nums">({revisions.length})</span>
      </summary>
      <ul className="mt-4 space-y-2">
        {revisions.map((r) => (
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
        ))}
      </ul>
    </details>
  );
}
