// L'étape d'un item (= une idée + ses contenus) est DÉRIVÉE, jamais stockée :
// la vue liste, le board et les compteurs de la sidebar partagent ces règles.
export type Stage = "proposed" | "writing" | "review" | "ready" | "published" | "discarded";
export type Bucket = "todo" | "writing" | "published" | "discarded";
export type ItemContent = { id: string; status: string; channelKey: string };

type StageInput = { status: string; contents: ItemContent[]; lastJobStatus: string | null };

// Première règle qui matche, de haut en bas (voir la table de la spec §3).
export function stageOf(
  ideaStatus: string, contents: ItemContent[], lastJobStatus: string | null
): Stage {
  const has = (s: string) => contents.some((c) => c.status === s);
  if (ideaStatus === "archived" || (contents.length > 0 && contents.every((c) => c.status === "rejected")))
    return "discarded";
  if (has("published") || ideaStatus === "done") return "published";
  if (has("approved")) return "ready";
  if (has("review")) return "review";
  if (
    has("generating") || has("draft") ||
    lastJobStatus === "queued" || lastJobStatus === "running" ||
    ideaStatus === "in_progress"
  ) return "writing";
  return "proposed";
}

export const BUCKET_STAGES: Record<Bucket, Stage[]> = {
  todo: ["proposed", "review", "ready"],
  writing: ["writing"],
  published: ["published"],
  discarded: ["discarded"],
};

export const BUCKET_LABELS: Record<Bucket, string> = {
  todo: "À traiter",
  writing: "En rédaction",
  published: "Publiés",
  discarded: "Écartés",
};

export const STAGE_LABELS: Record<Stage, string> = {
  proposed: "Proposé",
  writing: "Rédaction",
  review: "Relecture",
  ready: "Prêt",
  published: "Publié",
  discarded: "Écarté",
};

// Le contenu qu'on ouvre quand on clique l'item : le plus avancé.
// rejected est volontairement absent : un item écarté rouvre sa fiche idée.
const CONTENT_PRIORITY = ["published", "approved", "review", "generating", "draft"];
export function primaryContentOf(contents: ItemContent[]): ItemContent | null {
  for (const s of CONTENT_PRIORITY) {
    const found = contents.find((c) => c.status === s);
    if (found) return found;
  }
  return null;
}

export function countsByBucket(items: StageInput[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { todo: 0, writing: 0, published: 0, discarded: 0 };
  for (const it of items) {
    const stage = stageOf(it.status, it.contents, it.lastJobStatus);
    const bucket = (Object.keys(BUCKET_STAGES) as Bucket[])
      .find((b) => BUCKET_STAGES[b].includes(stage))!;
    counts[bucket] += 1;
  }
  return counts;
}
