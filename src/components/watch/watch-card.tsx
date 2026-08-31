"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ageRelatif, formaterCompteur, ratioMetriques,
  WATCH_REFUSAL_REASONS, MAX_WATCH_NOTE_LENGTH, type WatchRefusalReason,
} from "@/lib/watch-format";

export type WatchItemAuthor = {
  name?: string;
  handle?: string;
  avatar_url?: string;
  followers?: number;
};

export type WatchItemVisual = {
  type?: string;
  description?: string;
  reproducibility?: string;
  how_to?: string;
  text_read?: string;
};

export type WatchItemDTO = {
  id: string;
  externalId: string;
  url: string | null;
  author: WatchItemAuthor | null;
  textSource: string;
  lang: string | null;
  postedAt: string | null;
  metrics: Record<string, unknown> | null;
  media: unknown[] | null;
  visual: WatchItemVisual | null;
  textAdapted: string | null;
  score: number | null;
  status: "pool" | "proposed" | "validated" | "refused" | "expired";
  publicationUrl?: string | null;
  // Posé par create_idea (radar) : idée déjà repêchée depuis cet item pool.
  // Absent sur les DTO plus anciens qui ne le sélectionnent pas explicitement
  // — optionnel plutôt que `string | null` pour ne rien casser côté /watch.
  ideaId?: string | null;
};

const REFUSAL_LABELS: Record<WatchRefusalReason, string> = {
  hors_sujet: "Hors sujet",
  deja_traite: "Déjà traité",
  mauvais_angle: "Mauvais angle",
  autre: "Autre",
};

// Repli quand il n'y a pas d'avatar : 1 ou 2 initiales tirées du nom, sinon
// du handle (ex. "@Marie Curie" → "MC", "@mcurie" → "M").
function initiales(auteur: WatchItemAuthor): string {
  const base = auteur.name?.trim() || auteur.handle?.trim().replace(/^@/, "") || "";
  if (!base) return "?";
  const mots = base.split(/\s+/).filter(Boolean);
  const lettres = mots.slice(0, 2).map((m) => m[0]?.toUpperCase() ?? "");
  return lettres.join("") || "?";
}

function nombre(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Nom affiché d'un item (nom > handle > repli) — partagé entre l'écran du
 * matin (aria-labels de WatchCard) et le radar. */
export function nomAuteurAffiche(item: WatchItemDTO): string {
  const auteur = item.author ?? {};
  return auteur.name || auteur.handle || "Auteur inconnu";
}

/**
 * Aperçu du post source, partagé entre l'écran du matin (`WatchCard`,
 * colonne gauche) et le radar (`/watch/radar`, où il constitue toute la
 * carte hormis le bouton d'action) : auteur, texte, compteurs, image, bloc
 * visuel « comment refaire ».
 */
export function WatchSourcePreview({ item }: { item: WatchItemDTO }) {
  const auteur = item.author ?? {};
  const nomAffiche = nomAuteurAffiche(item);
  const metrics = item.metrics ?? {};
  const metricsEntries = Object.entries(metrics).filter(([, v]) => nombre(v) !== null);
  const saves = "saves" in metrics ? nombre(metrics.saves) : undefined;
  const likes = "likes" in metrics ? nombre(metrics.likes) : undefined;
  const ratio =
    "saves" in metrics && "likes" in metrics ? ratioMetriques(saves, likes) : null;
  const image = Array.isArray(item.media) && typeof item.media[0] === "string" ? item.media[0] : null;
  const age = item.postedAt ? ageRelatif(new Date(item.postedAt), new Date()) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2.5">
        {auteur.avatar_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- image externe, source arbitraire déposée par le worker
          <img
            src={auteur.avatar_url}
            alt=""
            className="size-9 shrink-0 rounded-full border border-line object-cover"
          />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-raised text-xs font-medium text-muted">
            {initiales(auteur)}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{nomAffiche}</p>
          {auteur.handle && auteur.name && (
            <p className="truncate text-xs text-faint">@{auteur.handle.replace(/^@/, "")}</p>
          )}
        </div>
        {age && <span className="ml-auto shrink-0 text-[11px] text-faint tabular-nums">{age}</span>}
      </div>

      <p className="whitespace-pre-wrap text-sm text-ink">{item.textSource}</p>

      {metricsEntries.length > 0 && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {metricsEntries.map(([cle, valeur]) => (
            <div key={cle} className="flex items-center gap-1">
              <dt className="text-faint">{cle}</dt>
              <dd className="text-ink tabular-nums">{formaterCompteur(nombre(valeur))}</dd>
            </div>
          ))}
        </dl>
      )}

      {ratio && (
        <p className="text-xs text-muted">
          Ratio saves / likes : <span className="text-ink tabular-nums">{ratio}</span>
        </p>
      )}

      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- image externe, source arbitraire déposée par le worker
        <img
          src={image}
          alt="Image du post source"
          className="max-h-48 w-full rounded-lg border border-line object-cover"
        />
      )}

      {item.visual && (
        <div className="rounded-lg border border-line bg-raised/40 p-3 text-xs">
          <p className="font-medium text-ink">{item.visual.type ?? "Visuel"}</p>
          {item.visual.how_to && <p className="mt-1 text-muted">{item.visual.how_to}</p>}
        </div>
      )}
    </div>
  );
}

export function WatchCard({
  item,
  busy,
  error,
  onValidate,
  onRefuse,
}: {
  item: WatchItemDTO;
  busy: boolean;
  error: string | null;
  onValidate: (id: string, editedText: string | undefined) => void;
  onRefuse: (id: string, reason: string | undefined, note: string | undefined) => void;
}) {
  const [texte, setTexte] = useState(item.textAdapted ?? "");
  const [motif, setMotif] = useState<string>("");
  const [note, setNote] = useState("");

  const nomAffiche = nomAuteurAffiche(item);

  function submitValidate() {
    const original = item.textAdapted ?? "";
    onValidate(item.id, texte !== original ? texte : undefined);
  }

  function submitRefuse() {
    onRefuse(item.id, motif || undefined, note || undefined);
  }

  return (
    <div className="grid gap-4 rounded-xl border border-line bg-surface p-4 lg:grid-cols-2">
      {/* Colonne gauche : le post source tel que déposé par le worker. */}
      <WatchSourcePreview item={item} />

      {/* Colonne droite : la décision — adapter, valider ou refuser. */}
      <div className="flex flex-col gap-3">
        <Textarea
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          disabled={busy}
          rows={6}
          aria-label={`Texte adapté pour la proposition de ${nomAffiche}`}
          className="min-h-32 flex-1 text-sm"
        />

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={submitValidate}
            disabled={busy || texte.trim().length === 0}
            aria-label={`Valider la proposition de ${nomAffiche}`}
          >
            {busy ? "…" : "Valider"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-raised/30 p-2">
          <label className="sr-only" htmlFor={`motif-${item.id}`}>
            Motif de refus (optionnel)
          </label>
          <select
            id={`motif-${item.id}`}
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            disabled={busy}
            className="h-8 rounded-lg border border-line bg-transparent px-2 text-xs text-ink outline-none focus-visible:border-accent"
          >
            <option value="">Motif (optionnel)</option>
            {WATCH_REFUSAL_REASONS.map((r) => (
              <option key={r} value={r}>
                {REFUSAL_LABELS[r]}
              </option>
            ))}
          </select>
          <label className="sr-only" htmlFor={`note-${item.id}`}>
            Note de refus (optionnel, {MAX_WATCH_NOTE_LENGTH} caractères max)
          </label>
          <Input
            id={`note-${item.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, MAX_WATCH_NOTE_LENGTH))}
            disabled={busy}
            maxLength={MAX_WATCH_NOTE_LENGTH}
            placeholder="Note (optionnel)"
            className="min-w-32 flex-1"
          />
          <span className="shrink-0 text-[10px] text-faint tabular-nums">
            {note.length}/{MAX_WATCH_NOTE_LENGTH}
          </span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={submitRefuse}
            disabled={busy}
            aria-label={`Refuser la proposition de ${nomAffiche}`}
          >
            Refuser
          </Button>
        </div>
      </div>
    </div>
  );
}
