"use client";
import { StatusBadge } from "@/components/cockpit/status-badge";
import type { CommentRow } from "@/components/review/use-comments";

/**
 * Colonne latérale de la relecture : les commentaires ouverts d'abord, les
 * traités repliés. `lost` = ceux dont le passage n'existe plus dans le corps
 * courant (le commentaire reste, il n'est simplement plus surlignable).
 */
export function CommentList({ comments, lost, onSelect, onGeneral, highlightsSupported }: {
  comments: CommentRow[]; lost: Set<string>;
  onSelect: (c: CommentRow) => void; onGeneral: () => void; highlightsSupported: boolean;
}) {
  const open = comments.filter((c) => c.status === "open");
  const closed = comments.filter((c) => c.status !== "open");
  const Card = ({ c }: { c: CommentRow }) => (
    <button type="button" onClick={() => onSelect(c)}
      className={`w-full rounded-lg border border-line bg-raised/40 p-2 text-left text-xs transition-colors duration-150 hover:border-line-strong ${c.status !== "open" ? "opacity-60" : ""}`}>
      {c.quote
        ? <span className="line-clamp-1 italic text-muted">« {c.quote} »</span>
        : <span className="text-muted">Commentaire général</span>}
      <span className="mt-1 block line-clamp-3">
        {c.transcription === "pending" ? "Transcription en cours…" : c.body || "—"}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-1">
        <StatusBadge kind="comment" value={c.status} />
        {c.kind === "voice" && <span className="text-faint">🎙️</span>}
        {c.transcription === "failed" && <span className="text-danger">transcription échouée</span>}
        {c.quote && lost.has(c.id) && <span className="text-warning">⚠️ passage introuvable</span>}
      </span>
    </button>
  );
  return (
    <aside className="space-y-3">
      {!highlightsSupported && (
        <p className="text-xs text-faint">
          Surlignage indisponible dans ce navigateur — la liste reste fonctionnelle.
        </p>
      )}
      <button type="button" onClick={onGeneral}
        className="w-full rounded-lg border border-dashed border-line p-2 text-xs text-muted transition-colors duration-150 hover:border-line-strong">
        + Commentaire général
      </button>
      {open.map((c) => <Card key={c.id} c={c} />)}
      {closed.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-faint">
            {closed.length} traité{closed.length > 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-2">{closed.map((c) => <Card key={c.id} c={c} />)}</div>
        </details>
      )}
    </aside>
  );
}
