"use client";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";

export function ProposedBanner({
  currentBody, proposedBody, onResolve,
}: {
  currentBody: string;
  proposedBody: string;
  onResolve: (action: "accept" | "reject") => void;
}) {
  const parts = diffLines(currentBody, proposedBody);
  return (
    <div className="space-y-3 rounded-xl border border-accent/40 bg-accent-soft p-4">
      <p className="text-sm font-medium">
        L&apos;agent a proposé une nouvelle version pendant que tu éditais :
      </p>
      <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-bg p-3 text-xs leading-5">
        {parts.map((part, i) => (
          <span key={i}
            className={part.added ? "block bg-success/15" : part.removed ? "block bg-danger/15 text-muted line-through" : "block"}>
            {part.value}
          </span>
        ))}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onResolve("accept")}>Accepter</Button>
        <Button size="sm" variant="outline" onClick={() => onResolve("reject")}>Rejeter</Button>
      </div>
    </div>
  );
}
