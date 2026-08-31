// Formatage pur pour l'écran veille (`/watch`). Fonctions sans effet de bord,
// testées isolément dans tests/watch-format.test.ts.
//
// WATCH_REFUSAL_REASONS et MAX_WATCH_NOTE_LENGTH sont déjà définies dans
// @/lib/watch (source de vérité serveur) — elles sont RE-déclarées ici plutôt
// qu'importées : @/lib/watch importe @/lib/db, qui embarque le driver
// `postgres` (Node natif, non bundleable côté navigateur). Un import direct
// depuis un composant client ("use client") casserait le build. Ce module-ci
// ne dépend que d'API JS standard : il est client-safe. Si l'une des deux
// listes de motifs ou la borne de longueur change côté serveur, répercuter
// le changement ici à la main.
export const WATCH_REFUSAL_REASONS = ["hors_sujet", "deja_traite", "mauvais_angle", "autre"] as const;
export type WatchRefusalReason = (typeof WATCH_REFUSAL_REASONS)[number];
export const MAX_WATCH_NOTE_LENGTH = 280;

const HEURE_MS = 3_600_000;
const JOUR_MS = 86_400_000;

/**
 * Âge relatif d'une date par rapport à `maintenant`, en français :
 * - sous 24 h : "il y a N h" ;
 * - de 1 à 6 jours pleins : "il y a N j" ;
 * - à partir de 7 jours pleins : date courte ("j moisAbrégé", ex. "24 août").
 */
export function ageRelatif(date: Date, maintenant: Date): string {
  const diffMs = Math.max(0, maintenant.getTime() - date.getTime());
  const heures = Math.floor(diffMs / HEURE_MS);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.floor(diffMs / JOUR_MS);
  if (jours < 7) return `il y a ${jours} j`;
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/**
 * Compteur compact façon réseau social : absent/NaN → "—", sous 1000 →
 * valeur telle quelle, au-delà → divisé par k/M avec au plus une décimale
 * (virgule française, zéro final supprimé : "1,2 k", "1 k", "3,4 M").
 */
export function formaterCompteur(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const [diviseur, suffixe]: [number, string] = abs < 1_000_000 ? [1000, "k"] : [1_000_000, "M"];
  const arrondi = Math.round((n / diviseur) * 10) / 10;
  const texte = Number.isInteger(arrondi) ? String(arrondi) : arrondi.toFixed(1);
  return `${texte.replace(".", ",")} ${suffixe}`;
}

/**
 * Ratio a/b à 2 décimales (virgule française). "—" si non calculable
 * (b absent ou nul) — a absent est traité comme 0.
 */
export function ratioMetriques(a: number | null | undefined, b: number | null | undefined): string {
  if (b == null || b === 0) return "—";
  const ratio = (a ?? 0) / b;
  return ratio.toFixed(2).replace(".", ",");
}
