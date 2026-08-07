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
    <div className="rounded-lg border border-blue-400 bg-blue-50 p-4 space-y-3">
      <p className="text-sm font-medium">
        L&apos;agent a proposé une nouvelle version pendant que tu éditais :
      </p>
      <pre className="max-h-64 overflow-auto rounded bg-white p-3 text-xs leading-5">
        {parts.map((part, i) => (
          <span key={i}
            className={part.added ? "block bg-green-100" : part.removed ? "block bg-red-100 line-through" : "block"}>
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
