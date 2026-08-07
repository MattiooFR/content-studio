"use client";
import { useState } from "react";
import { diffLines } from "diff";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Révisions ({revisions.length})
      </summary>
      <ul className="mt-3 space-y-2">
        {revisions.map((r) => (
          <li key={r.id} className="text-sm">
            <div className="flex w-full items-center gap-2">
              <button className="flex flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                <Badge variant={r.state === "current" ? "default" : "outline"}>{r.state}</Badge>
                <span>{r.authorType === "agent" ? `agent (${r.authorLabel})` : "toi"}</span>
                <span className="text-muted-foreground">
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
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 text-xs leading-5">
                {diffLines(r.body, currentBody).map((part, i) => (
                  <span key={i}
                    className={part.added ? "block bg-green-100" : part.removed ? "block bg-red-100 line-through" : "block"}>
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
