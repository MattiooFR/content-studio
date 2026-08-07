import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type FunnelRow = {
  channelKey: string;
  channelName: string;
  ideas: number;
  drafts: number;
  inReview: number;
  approved: number;
  published: number;
  rejected: number;
  bottleneck: string | null;
};

type Row = {
  channel_key: string;
  channel_name: string;
  ideas: number;
  drafts: number;
  in_review: number;
  approved: number;
  published: number;
  rejected: number;
  stale_review: number;
};

/**
 * Une ligne par canal DU WORKSPACE (même sans contenu — LEFT JOIN, pas de
 * canal absent faute d'activité). UNE seule requête groupée (canal × statut,
 * via `count(*) filter`) : pas de N+1 en bouclant sur les canaux.
 *
 * Identifiants qualifiés À LA MAIN (alias ch/ct + noms de colonnes littéraux)
 * plutôt qu'interpolés (`${contents.status}`) : piège déjà documenté dans
 * `src/lib/ideas.ts` — drizzle peut émettre un identifiant non qualifié que
 * Postgres relie à la mauvaise table dans la portée la plus proche.
 *
 * `approved` est un champ à part entière (arbitrage post-W6, 2026-08-08) :
 * la première version l'omettait de la sortie ("TELS QUELS" du brief W6 mal
 * lu contre l'exemple sans approved du brief W7), ce qui faisait disparaître
 * un contenu approuvé du pipeline affiché — ni en review, ni publié. Aucun
 * regroupement croisé entre statuts : approved ne s'ajoute ni à inReview ni
 * à published, il a sa propre colonne.
 */
export async function computeFunnel(workspaceId: string): Promise<FunnelRow[]> {
  const rows = (await db.execute(sql`
    select
      ch.key as channel_key,
      ch.name as channel_name,
      count(distinct ct.idea_id)::int as ideas,
      count(*) filter (where ct.status = 'draft')::int as drafts,
      count(*) filter (where ct.status = 'review')::int as in_review,
      count(*) filter (where ct.status = 'approved')::int as approved,
      count(*) filter (where ct.status = 'published')::int as published,
      count(*) filter (where ct.status = 'rejected')::int as rejected,
      count(*) filter (
        where ct.status = 'review' and ct.updated_at < now() - interval '7 days'
      )::int as stale_review
    from channels ch
    left join contents ct
      on ct.channel_id = ch.id and ct.workspace_id = ch.workspace_id
    where ch.workspace_id = ${workspaceId}
    group by ch.id, ch.key, ch.name
    order by ch.name
  `)) as unknown as Row[];

  return rows.map((r) => {
    const staleReview = Number(r.stale_review);
    return {
      channelKey: r.channel_key,
      channelName: r.channel_name,
      ideas: Number(r.ideas),
      drafts: Number(r.drafts),
      inReview: Number(r.in_review),
      approved: Number(r.approved),
      published: Number(r.published),
      rejected: Number(r.rejected),
      bottleneck: staleReview >= 1
        ? `${staleReview} contenus en review depuis plus de 7 jours`
        : null,
    };
  });
}
