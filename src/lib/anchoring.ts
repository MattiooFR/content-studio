/**
 * Ancrage d'un commentaire dans un texte (port de `trouverPassage`, outil de
 * relecture VDL). Trois niveaux, du plus strict au plus permissif ; null si
 * le passage a disparu (le commentaire reste listé, plus surligné).
 */
export function normalizeWs(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

// Entités HTML repliées en avance (multi-caractères dans la source) lors de
// la construction de la table de positions du niveau 2 — sinon un caractère
// source à la fois ne peut jamais matcher une séquence de 5-6 caractères.
const ENTITIES: [string, string][] = [
  ["&amp;", "&"],
  ["&nbsp;", " "],
];

export function findPassage(full: string, quote: string, prefix: string, suffix: string):
  { start: number; end: number; level: 1 | 2 | 3 } | null {
  if (!quote) return null;
  // 1 — exact, contexte compris
  const exact = full.indexOf((prefix || "") + quote + (suffix || ""));
  if (exact !== -1) {
    const start = exact + (prefix || "").length;
    return { start, end: start + quote.length, level: 1 };
  }
  // 2 — blancs/entités/apostrophes normalisés, en conservant deux tables de
  // positions : `map` (index source de DÉBUT de chaque caractère produit) et
  // `mapEnd` (index source de FIN, exclusif). Un caractère produit peut venir
  // de PLUSIEURS caractères source (une entité "&nbsp;" = 6 caractères
  // source pour 1 espace produit ; un bloc d'espaces fusionné en 1 seul
  // espace produit) : `end` ne peut donc pas se déduire de `map` seul (+1)
  // sous peine de tronquer la tranche source au milieu d'une entité ou d'un
  // bloc d'espaces.
  const map: number[] = [];
  const mapEnd: number[] = [];
  let norm = "";
  let i = 0;
  while (i < full.length) {
    let consumed = 1;
    let piece = normalizeWs(full[i]);
    for (const [entity, replacement] of ENTITIES) {
      if (full.startsWith(entity, i)) {
        piece = replacement;
        consumed = entity.length;
        break;
      }
    }
    for (const ch of piece) {
      if (ch === " " && norm.endsWith(" ")) {
        // ce caractère (ou cette entité) rejoint le bloc d'espace précédent :
        // on ne produit rien de nouveau, mais on repousse la borne de fin du
        // dernier caractère produit jusqu'après CE caractère source, pour que
        // `end` couvre tout le bloc d'espaces fusionnés, pas seulement son
        // premier caractère
        mapEnd[mapEnd.length - 1] = i + consumed;
        continue;
      }
      norm += ch;
      map.push(i);
      mapEnd.push(i + consumed);
    }
    i += consumed;
  }
  const nq = normalizeWs(quote), np = normalizeWs(prefix || "").trimStart(), ns = normalizeWs(suffix || "").trimEnd();
  let idx = norm.indexOf(np + nq + ns);
  if (idx !== -1) {
    const s = idx + np.length;
    return { start: map[s], end: mapEnd[s + nq.length - 1], level: 2 };
  }
  // 3 — quote seule (première occurrence)
  const bare = full.indexOf(quote);
  if (bare !== -1) return { start: bare, end: bare + quote.length, level: 3 };
  idx = norm.indexOf(nq);
  if (idx !== -1) return { start: map[idx], end: mapEnd[idx + nq.length - 1], level: 3 };
  return null;
}
