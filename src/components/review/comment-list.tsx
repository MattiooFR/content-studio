"use client";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { useJobs } from "@/hooks/use-jobs";
import type { CommentRow } from "@/components/review/use-comments";

/**
 * Relance d'une transcription échouée (spec §3.4). Le job `transcribe` porte
 * l'audio, conservé en base tant que la transcription n'a pas abouti : le
 * réessai repart donc du même enregistrement, il n'y a rien à redicter.
 *
 * Monté UNIQUEMENT sur une carte dont la transcription a échoué — chaque
 * instance ouvre un `useJobs`, donc un abonnement aux événements ; c'est sans
 * conséquence depuis que la connexion SSE est partagée (voir
 * `use-workspace-events.ts`).
 */
function RetryTranscription({ commentId }: { commentId: string }) {
  const jobs = useJobs("comment", commentId);
  const job = jobs.latest("transcribe");
  // Aucun job retrouvé (purgé, ou dictée dont le job n'a jamais pu être créé)
  // : rien à relancer, on n'affiche pas de bouton qui ne marcherait pas.
  if (!job) return null;
  const running = job.status === "queued" || job.status === "running";
  if (!running && job.status !== "failed") return null;
  return (
    <div className="border-t border-line px-2 py-1.5">
      {running ? (
        // le bouton disparaît pendant la relance, mais on garde un retour
        // visible : la carte, elle, affiche encore « transcription échouée »
        // jusqu'à ce que le worker aboutisse
        <span className="text-[10px] tracking-wider text-muted uppercase">Nouvelle transcription…</span>
      ) : (
        <button type="button" onClick={() => jobs.retry(job.id)}
          className="rounded-full border border-line bg-raised px-2 py-0.5 text-[10px] font-medium tracking-wider text-muted uppercase transition-colors duration-150 hover:border-line-strong hover:text-ink">
          Réessayer
        </button>
      )}
      {jobs.error && <span className="ml-2 text-[10px] text-danger">{jobs.error}</span>}
    </div>
  );
}

/**
 * Une carte. Définie au NIVEAU MODULE, pas dans le corps de `CommentList` :
 * un composant recréé à chaque rendu du parent est un type de composant
 * neuf à chaque fois, donc React démonte et remonte tout le sous-arbre — ce
 * qui relancerait le `useJobs` de « Réessayer » (fetch + abonnement) à
 * chaque rafraîchissement de la liste.
 *
 * C'est un <div> qui CONTIENT un bouton, et non un bouton : « Réessayer »
 * est lui-même un bouton, et un bouton imbriqué dans un bouton est du HTML
 * invalide (React s'en plaint, et le clic intérieur déclencherait aussi
 * celui de l'extérieur).
 */
function CommentCard({ c, lost, onSelect }: {
  c: CommentRow; lost: boolean; onSelect: (c: CommentRow) => void;
}) {
  return (
    <div className={`overflow-hidden rounded-lg border border-line bg-raised/40 text-xs transition-colors duration-150 hover:border-line-strong ${c.status !== "open" ? "opacity-60" : ""}`}>
      <button type="button" onClick={() => onSelect(c)} className="block w-full p-2 text-left">
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
          {c.quote && lost && <span className="text-warning">⚠️ passage introuvable</span>}
        </span>
      </button>
      {c.transcription === "failed" && <RetryTranscription commentId={c.id} />}
    </div>
  );
}

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
  const card = (c: CommentRow) => (
    <CommentCard key={c.id} c={c} lost={lost.has(c.id)} onSelect={onSelect} />
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
      {open.map(card)}
      {closed.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-faint">
            {closed.length} traité{closed.length > 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-2">{closed.map(card)}</div>
        </details>
      )}
    </aside>
  );
}
