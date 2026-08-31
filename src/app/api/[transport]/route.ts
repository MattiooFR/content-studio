import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, artDirections } from "@/lib/db/schema";
import { resolveMcpToken } from "@/lib/tenant";
import { listIdeas, getIdea, createIdea, updateIdea } from "@/lib/ideas";
import { listPersonas } from "@/lib/personas";
import {
  createContentDraft, getContent, applyContentUpdate, listContents, setContentStatus,
} from "@/lib/contents";
import { listComments, updateComment } from "@/lib/comments";
import { findPassage } from "@/lib/anchoring";
import {
  addSource, listSources, getSource, attachExtraction,
} from "@/lib/sources";
import { listJobs, claimJob, heartbeatJob, completeJob, failJob, JobStateError } from "@/lib/jobs";
import { listPublications, linkPublication, markSynced } from "@/lib/publications";
import {
  getWatchConfig, upsertWatchItems, listWatchItems, markFeedFetched,
  upsertWatchFeed, updateWatchSettings,
} from "@/lib/watch";

// NOTE version : mcp-handler 2.1.0 exporte à la fois `withMcpAuth` et
// `experimental_withMcpAuth` (alias identique). On utilise le nom stable.
//
// NOTE version (au-delà de l'import) : le peer `@modelcontextprotocol/server`
// installé est en ^2.0.0 — le `McpServer` de cette génération n'a PAS de
// raccourci `.tool(name, description, schema, cb)` (confirmé par
// `grep registerTool node_modules/@modelcontextprotocol/server/dist/*.mjs` :
// seule `registerTool(name, config, cb)` existe ; `.tool` plante en
// `TypeError: server.tool is not a function` au premier appel réel).
// Idem, cette version n'a pas d'option `basePath` sur `createMcpHandler` :
// le routing vient uniquement de l'emplacement du fichier
// (`src/app/api/[transport]/route.ts` → `/api/mcp`).
// Idem, l'auth n'atterrit pas sur `extra.authInfo` mais sur
// `extra.http.authInfo` (cf. `ServerContext`/`BaseContext` dans
// createMcpHandler-*.d.mts).

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

const wsOf = (extra: { http?: { authInfo?: { extra?: Record<string, unknown> } } }) => {
  const workspaceId = extra.http?.authInfo?.extra?.workspaceId;
  if (typeof workspaceId !== "string") throw new Error("authInfo manquant");
  return workspaceId;
};

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_ideas",
      {
        description: "Liste les idées du workspace (l'inbox de l'agent). Filtre optionnel par statut.",
        inputSchema: { status: z.enum(["inbox", "in_progress", "done", "archived"]).optional() },
      },
      async ({ status }, extra) => json(await listIdeas(wsOf(extra), status))
    );

    server.registerTool(
      "create_idea",
      {
        description: "Dépose une nouvelle idée dans l'inbox du workspace (statut inbox). Pour quand l'idée arrive par l'agent — dictée, veille, brief oral — et pas par l'UI. Rend l'idée créée, avec son id à passer ensuite à create_content_draft.",
        inputSchema: {
          title: z.string().trim().min(1, "titre requis"),
          notes: z.string().optional(),
          source_url: z.string().url().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      async ({ title, notes, source_url, tags }, extra) =>
        json(await createIdea(wsOf(extra), {
          title, notes, sourceUrl: source_url, tags,
        }))
    );

    server.registerTool(
      "get_idea",
      {
        description: "Une idée + le résumé de ses contenus existants.",
        inputSchema: { idea_id: z.string().uuid() },
      },
      async ({ idea_id }, extra) => {
        const workspaceId = wsOf(extra);
        const idea = await getIdea(workspaceId, idea_id);
        if (!idea) return json({ error: "idée introuvable" });
        const contents = await listContents(workspaceId, idea_id);
        const sources = await listSources(workspaceId, { ideaId: idea_id });
        return json({
          idea,
          contents: contents.map((c) => ({
            id: c.id, channelId: c.channelId, type: c.type,
            status: c.status, updatedAt: c.updatedAt,
          })),
          sources: sources.map((s) => ({
            id: s.id, kind: s.kind, title: s.title, status: s.status,
          })),
        });
      }
    );

    server.registerTool(
      "list_channels",
      {
        description: "Les canaux du workspace, avec leurs contraintes (longueur, structure, format d'export). À LIRE avant d'écrire.",
        inputSchema: {},
      },
      async (_args, extra) =>
        json(await db.select().from(channels)
          .where(eq(channels.workspaceId, wsOf(extra))))
    );

    server.registerTool(
      "list_personas",
      {
        description: "Les personas du workspace : voix, audience, langue. À respecter dans la rédaction.",
        inputSchema: {},
      },
      async (_args, extra) => json(await listPersonas(wsOf(extra)))
    );

    server.registerTool(
      "get_art_direction",
      {
        description: "Une direction artistique : palette, style, voix, personas visuels. À lire avant toute génération visuelle.",
        inputSchema: { art_direction_id: z.string().uuid() },
      },
      async ({ art_direction_id }, extra) => {
        const [row] = await db.select().from(artDirections)
          .where(and(
            eq(artDirections.id, art_direction_id),
            eq(artDirections.workspaceId, wsOf(extra))
          ));
        return json(row ?? { error: "direction artistique introuvable" });
      }
    );

    server.registerTool(
      "create_content_draft",
      {
        description: "Crée un contenu vide pour une idée sur un canal (persona optionnel). Rend content_id.",
        inputSchema: {
          idea_id: z.string().uuid(),
          channel_key: z.string(),
          persona_id: z.string().uuid().optional(),
        },
      },
      async ({ idea_id, channel_key, persona_id }, extra) =>
        json(await createContentDraft({
          workspaceId: wsOf(extra), ideaId: idea_id,
          channelKey: channel_key, personaId: persona_id,
        }))
    );

    server.registerTool(
      "get_content",
      {
        description: "Le contenu courant : corps markdown, statut, canal, révision courante. Base de toute itération.",
        inputSchema: { content_id: z.string().uuid() },
      },
      async ({ content_id }, extra) => {
        const c = await getContent(wsOf(extra), content_id);
        return json(c ?? { error: "contenu introuvable" });
      }
    );

    server.registerTool(
      "update_content",
      {
        description: "Écrit une nouvelle version du contenu (markdown complet, pas un diff). Si un humain est en train d'éditer, la version part en 'proposed' et lui est montrée en diff — c'est normal, ne pas ré-essayer. lane_id optionnel : si cet appel a lieu DANS une conversation de lane (Task W11), passe-le pour que la révision porte le tag lane:<id> — la page contenu affiche alors un lien « ouvrir la conversation » dessus.",
        inputSchema: { content_id: z.string().uuid(), body: z.string(), lane_id: z.string().uuid().optional() },
      },
      async ({ content_id, body, lane_id }, extra) =>
        json(await applyContentUpdate({
          workspaceId: wsOf(extra), contentId: content_id,
          body, authorType: "agent", authorLabel: "mcp", laneId: lane_id,
        }))
    );

    // ---- relecture : les remarques de l'humain, à appliquer par l'agent -------
    server.registerTool(
      "list_comments",
      {
        description: "Les commentaires de relecture d'un contenu (surlignage + remarque, écrite ou dictée). Chaque entrée porte quote/prefix/suffix (ancrage), body (la remarque), status (open = à traiter), et anchor_found/position calculés sur le markdown courant (start/end = offsets dans le corps ; null si le passage a disparu). Attention : quote/prefix/suffix proviennent du texte RENDU (sans marqueurs markdown), alors que position est recalculée sur le markdown SOURCE — elle peut être null (passage formaté ou à cheval sur deux blocs) ou une simple première occurrence (level 3). Vérifier position.level (1 = exact, 2 = normalisé, 3 = quote seule) avant de remplacer à l'offset ; en cas de doute, retrouver le passage par la quote plutôt que par l'offset. Appliquer = réécrire uniquement les passages visés, puis resolve_comment(status: applied).",
        inputSchema: { content_id: z.string().uuid(), status: z.enum(["open", "applied", "resolved"]).optional() },
      },
      async ({ content_id, status }, extra) => {
        const workspaceId = wsOf(extra);
        const content = await getContent(workspaceId, content_id);
        if (!content) return json({ error: "contenu introuvable dans ce workspace" });
        const rows = await listComments(workspaceId, content_id, { status });
        return json(rows.map((c) => {
          const position = c.quote ? findPassage(content.body, c.quote, c.prefix, c.suffix) : null;
          return { ...c, anchor_found: position !== null, position };
        }));
      }
    );
    server.registerTool(
      "resolve_comment",
      {
        description: "Change le statut d'un commentaire : applied (l'agent a appliqué la remarque), resolved (clos sans changement), open (rouvert).",
        inputSchema: { comment_id: z.string().uuid(), status: z.enum(["open", "applied", "resolved"]) },
      },
      async ({ comment_id, status }, extra) =>
        json((await updateComment(wsOf(extra), comment_id, { status })) ?? { error: "commentaire introuvable dans ce workspace" })
    );

    server.registerTool(
      "list_sources",
      {
        description: "Liste les sources du workspace (url/video/text). Filtres optionnels : status ('pending' = extraction en attente), idea_id (les sources d'une idée).",
        inputSchema: {
          status: z.enum(["pending", "extracted", "failed"]).optional(),
          idea_id: z.string().uuid().optional(),
        },
      },
      async ({ status, idea_id }, extra) =>
        json(await listSources(wsOf(extra), { status, ideaId: idea_id }))
    );

    server.registerTool(
      "get_source",
      {
        description: "Une source : ref, extrait brut, texte extrait (si déjà attaché), statut.",
        inputSchema: { source_id: z.string().uuid() },
      },
      async ({ source_id }, extra) => {
        const row = await getSource(wsOf(extra), source_id);
        return json(row ?? { error: "source introuvable" });
      }
    );

    server.registerTool(
      "add_source",
      {
        description: "Dépose une source sur une idée. kind url/video : ref = URL (une URL YouTube passée en url est reclassée video) → status pending + job extract pour le worker. kind text : passe le contenu (long) dans `text` → extraite d'emblée. pdf/audio (upload binaire) refusés en v1.1.",
        inputSchema: {
          idea_id: z.string().uuid(),
          kind: z.enum(["url", "pdf", "audio", "video", "text"]),
          ref: z.string().optional(),
          text: z.string().optional(),
          title: z.string().optional(),
          raw_excerpt: z.string().optional(),
        },
      },
      async ({ idea_id, kind, ref, text, title, raw_excerpt }, extra) =>
        json(await addSource(wsOf(extra), {
          ideaId: idea_id, kind, ref, text, title, rawExcerpt: raw_excerpt,
        }))
    );

    server.registerTool(
      "attach_extraction",
      {
        description: "Rattache le texte extrait par l'agent (transcript, contenu de page, texte de PDF) à une source. Passe son statut à 'extracted'. Borné à 1 500 000 caractères. Le worker enchaîne avec complete_job — un job extract ne passe done que si la source est extraite.",
        inputSchema: {
          source_id: z.string().uuid(),
          extracted_text: z.string(),
          extracted_meta: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async ({ source_id, extracted_text, extracted_meta }, extra) => {
        const row = await attachExtraction(wsOf(extra), source_id, {
          extractedText: extracted_text, extractedMeta: extracted_meta,
        });
        return json(row ?? { error: "source introuvable" });
      }
    );

    server.registerTool(
      "register_asset",
      {
        description: "Réservé v1.1 : enregistrement d'assets (images/vidéos).",
        inputSchema: { kind: z.enum(["image", "video", "audio"]), mime: z.string() },
      },
      async () => json({ error: "register_asset arrive en v1.1 — v1 est texte uniquement" })
    );

    // ---- jobs : la file de travail du worker externe -----------------------
    // Une erreur métier (introuvable, transition refusée) est rendue en
    // `{ error }` : le worker la lit et décide, pas d'exception JSON-RPC.
    const jobOr = async (p: Promise<unknown>) => {
      try {
        const row = await p;
        return json(row ?? { error: "job introuvable dans ce workspace" });
      } catch (e) {
        if (e instanceof JobStateError) return json({ error: e.message, code: e.code });
        throw e;
      }
    };

    server.registerTool(
      "list_jobs",
      {
        description: "Les jobs du workspace (demandes posées par l'humain ou par l'outil), plus anciens d'abord. Sans filtre : tous. Un worker sonde `status: \"queued\"`, puis claim_job. Chaque job porte kind, target_type/target_id, payload, et targetTitle (résumé de la cible).",
        inputSchema: {
          status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
          kind: z.string().optional(),
        },
      },
      async ({ status, kind }, extra) =>
        json(await listJobs(wsOf(extra), { status, kind, order: "asc" }))
    );

    server.registerTool(
      "claim_job",
      {
        description: "Prend un job queued (atomique : un seul worker gagne). Rend le job en running, ou { error } s'il est déjà pris/terminé/introuvable. Pendant un travail long, appeler heartbeat_job toutes les 60 s : sans battement pendant 10 min, le job est basculé en failed.",
        inputSchema: { job_id: z.string().uuid(), worker_label: z.string().trim().min(1).max(64) },
      },
      async ({ job_id, worker_label }, extra) => jobOr(claimJob(wsOf(extra), job_id, worker_label))
    );

    server.registerTool(
      "heartbeat_job",
      { description: "Signale que le worker travaille toujours sur ce job (running).", inputSchema: { job_id: z.string().uuid() } },
      async ({ job_id }, extra) => jobOr(heartbeatJob(wsOf(extra), job_id))
    );

    server.registerTool(
      "complete_job",
      {
        description: "Termine un job running avec un résultat (ex. { content_id } pour write, { url } pour publish, { text } pour transcribe). Les statuts des cibles se posent à part (set_content_status, update_idea, link_publication…) — sauf transcribe, dont le texte est écrit dans le commentaire par l'outil.",
        inputSchema: { job_id: z.string().uuid(), result: z.record(z.string(), z.unknown()).optional() },
      },
      async ({ job_id, result }, extra) => jobOr(completeJob(wsOf(extra), job_id, result ?? {}))
    );

    server.registerTool(
      "fail_job",
      {
        description: "Échoue un job running avec un message lisible par l'humain (affiché tel quel dans l'UI, tronqué à 2000 caractères). Pas de réessai automatique : c'est le bouton de l'UI.",
        inputSchema: { job_id: z.string().uuid(), error: z.string().min(1) },
      },
      async ({ job_id, error }, extra) => jobOr(failJob(wsOf(extra), job_id, error))
    );

    server.registerTool(
      "set_content_status",
      {
        description: "Pose le statut d'un contenu (draft, review, approved, published, generating, rejected). Le worker s'en sert après write (review) et publish (published).",
        inputSchema: {
          content_id: z.string().uuid(),
          status: z.enum(["draft", "review", "approved", "published", "generating", "rejected"]),
        },
      },
      async ({ content_id, status }, extra) => {
        try {
          return json(await setContentStatus(wsOf(extra), content_id, status));
        } catch (e) {
          if (e instanceof Error && e.message.includes("introuvable")) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "update_idea",
      {
        description: "Met à jour une idée : statut (inbox, in_progress, done, archived), notes, tags. Les champs absents ne bougent pas.",
        inputSchema: {
          idea_id: z.string().uuid(),
          status: z.enum(["inbox", "in_progress", "done", "archived"]).optional(),
          notes: z.string().optional(),
          tags: z.array(z.string()).optional(),
        },
      },
      async ({ idea_id, status, notes, tags }, extra) => {
        const row = await updateIdea(wsOf(extra), idea_id, { status, notes, tags });
        return json(row ?? { error: "idée introuvable dans ce workspace" });
      }
    );

    // ---- publications : le lien vers l'objet publié par le worker --------------
    server.registerTool(
      "list_publications",
      {
        description: "Les publications du workspace (lien contenu ↔ objet publié sur une cible externe : external_id, url, hash du corps publié, synced_at, last_error). Filtres : target, content_id. Un worker s'en sert pour l'import (« ce feed est-il déjà lié ? ») et le sync (« quel external_id ? »).",
        inputSchema: { target: z.string().optional(), content_id: z.string().uuid().optional() },
      },
      async ({ target, content_id }, extra) => json(await listPublications(wsOf(extra), { target, contentId: content_id }))
    );
    server.registerTool(
      "link_publication",
      {
        description: "Déclare (ou met à jour) qu'un contenu est publié sur une cible : target (ex. fluentcommunity), external_id, url, meta, body_hash = sha256 hex du corps markdown tel que publié. Upsert sur (content, target). À appeler juste après une publication réussie.",
        inputSchema: {
          content_id: z.string().uuid(), target: z.string().trim().min(1), external_id: z.string().trim().min(1),
          url: z.string().optional(), meta: z.record(z.string(), z.unknown()).optional(), body_hash: z.string().min(1),
        },
      },
      async ({ content_id, target, external_id, url, meta, body_hash }, extra) => {
        try {
          return json(await linkPublication(wsOf(extra), { contentId: content_id, target, externalId: external_id, url, meta, bodyHash: body_hash }));
        } catch (e) {
          if (e instanceof Error && (e.message.includes("introuvable") || e.message.includes("requis"))) return json({ error: e.message });
          throw e;
        }
      }
    );
    server.registerTool(
      "mark_synced",
      {
        description: "Après un sync réussi : pose le nouveau hash du corps publié, synced_at = maintenant, efface last_error.",
        inputSchema: { publication_id: z.string().uuid(), body_hash: z.string().min(1) },
      },
      async ({ publication_id, body_hash }, extra) =>
        json((await markSynced(wsOf(extra), publication_id, body_hash)) ?? { error: "publication introuvable dans ce workspace" })
    );

    // ---- veille : dépôt/lecture du worker externe, réglages posés par l'UI ---
    const watchItemSchema = z.object({
      external_id: z.string().trim().min(1),
      // NOTE : pas un z.enum(["pool","proposed"]) — un rejet zod ici sort en
      // tool-result isError:true avec un texte brut NON JSON (vérifié dans
      // @modelcontextprotocol/server, mcp-DXXb3Vv3.mjs:1432), pas en `{ error
      // }` dans le content. Le contrat veut un statut invalide rendu en
      // { error } (parseable) : on laisse passer la chaîne et c'est
      // validateItem (lib/watch.ts) qui tranche et jette, capté par le
      // try/catch du handler ci-dessous.
      status: z.string(),
      text_source: z.string().min(1),
      url: z.string().url().optional(),
      author: z.record(z.string(), z.unknown()).optional(),
      lang: z.string().optional(),
      posted_at: z.string().optional(),
      metrics: z.record(z.string(), z.unknown()).optional(),
      media: z.array(z.unknown()).optional(),
      visual: z.record(z.string(), z.unknown()).optional(),
      text_adapted: z.string().optional(),
      score: z.number().optional(),
    });

    server.registerTool(
      "get_watch_config",
      {
        description: "Réglages veille (topics, style, require_media, channel_key) et feeds actifs du workspace. publish_config est rendu EN CLAIR ici (jamais dans l'UI, qui le rédige) : c'est la configuration de publication du worker sur le canal de veille — à traiter comme un secret côté worker, ne jamais la reloguer.",
        inputSchema: {},
      },
      async (_args, extra) => json(await getWatchConfig(wsOf(extra)))
    );

    server.registerTool(
      "upsert_watch_items",
      {
        description: "Dépose des items de veille (lot ≤ 200). status pool = corpus exploré (radar), proposed = file du matin (avec text_adapted + score). Idempotent sur (workspace, external_id) ; un item déjà décidé (validated/refused/expired) est ignoré et compté dans skipped — ne pas réessayer. Un statut hors pool/proposed rend { error }, ne pose rien.",
        inputSchema: { items: z.array(watchItemSchema).max(200) },
      },
      async ({ items }, extra) => {
        try {
          return json(await upsertWatchItems(wsOf(extra), items.map((i) => ({
            externalId: i.external_id, status: i.status as "pool" | "proposed", textSource: i.text_source,
            url: i.url, author: i.author, lang: i.lang, postedAt: i.posted_at,
            metrics: i.metrics, media: i.media, visual: i.visual,
            textAdapted: i.text_adapted, score: i.score,
          }))));
        } catch (e) {
          if (e instanceof Error) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "list_watch_items",
      {
        description: "Items de veille du workspace, meilleur score d'abord puis dépôt le plus récent. status filtre (pool = corpus exploré, proposed = file du matin à traiter, validated/refused/expired = déjà décidés, immuables — ne pas re-proposer). since (ISO 8601) : items déposés/actualisés depuis. limit ≤ 500 (défaut 100). Chaque item porte external_id, text_source, text_adapted, score, status, refusal_reason/refusal_note si refusé, decided_at.",
        inputSchema: {
          status: z.enum(["pool", "proposed", "validated", "refused", "expired"]).optional(),
          since: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
        },
      },
      async ({ status, since, limit }, extra) => {
        if (since !== undefined && Number.isNaN(Date.parse(since))) {
          return json({ error: "since invalide (ISO 8601 attendu)" });
        }
        try {
          return json(await listWatchItems(wsOf(extra), {
            status, since: since ? new Date(since) : undefined, limit,
          }));
        } catch (e) {
          if (e instanceof Error) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "upsert_watch_feed",
      {
        description: "Crée ou met à jour un feed de veille suivi par le worker. kind account = compte à suivre, query = recherche/mot-clé. Upsert sur (workspace, kind, label) : rejouer avec le même kind+label met à jour params/enabled sans dupliquer. params est libre, interprété par le worker (cadence, langue, fenêtre…).",
        inputSchema: {
          kind: z.enum(["account", "query"]),
          label: z.string().trim().min(1),
          params: z.record(z.string(), z.unknown()).optional(),
          enabled: z.boolean().optional(),
        },
      },
      async ({ kind, label, params, enabled }, extra) => {
        try {
          return json(await upsertWatchFeed(wsOf(extra), { kind, label, params, enabled }));
        } catch (e) {
          if (e instanceof Error) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "mark_feed_fetched",
      {
        description: "Marque un feed comme rafraîchi maintenant (last_fetched_at). À appeler par le worker juste après avoir traité ce feed (qu'il ait ou non trouvé de nouveaux items).",
        inputSchema: { feed_id: z.string().uuid() },
      },
      async ({ feed_id }, extra) => {
        try {
          return json(await markFeedFetched(wsOf(extra), feed_id));
        } catch (e) {
          if (e instanceof Error) return json({ error: e.message });
          throw e;
        }
      }
    );

    server.registerTool(
      "update_watch_settings",
      {
        description: "Met à jour les réglages veille (champs omis = inchangés). channel_key doit exister dans les canaux du workspace (sinon { error }) — c'est le canal sur lequel une validation crée son contenu. publish_config : objet de chaînes (500 caractères par valeur, 20 clés max sur le résultat) mergé clé par clé avec l'existant si fourni — une clé fournie écrase ou ajoute, une clé absente du patch survit, une clé fournie à null est supprimée — la configuration de publication que get_watch_config rend en clair au worker.",
        inputSchema: {
          topics: z.array(z.string()).optional(),
          style: z.string().optional(),
          require_media: z.boolean().optional(),
          channel_key: z.string().optional(),
          publish_config: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async ({ topics, style, require_media, channel_key, publish_config }, extra) => {
        try {
          return json(await updateWatchSettings(wsOf(extra), {
            topics, style, requireMedia: require_media,
            channelKey: channel_key, publishConfig: publish_config,
          }));
        } catch (e) {
          if (e instanceof Error) return json({ error: e.message });
          throw e;
        }
      }
    );
  },
  {}
);

const authed = withMcpAuth(
  handler,
  async (_req, bearer) => {
    const resolved = await resolveMcpToken(bearer ? `Bearer ${bearer}` : null);
    if (!resolved) {
      // Deux 401 distincts. `undefined` fait dire à mcp-handler « No
      // authorization provided » — faux si un Bearer était là, juste invalide,
      // et trompeur pour qui débogue son branchement. Lever fait passer la lib
      // par son autre chemin, qui répond « Invalid token ».
      if (bearer) throw new Error("token inconnu ou révoqué");
      return undefined; // vraiment aucun token → 401 « No authorization provided »
    }
    return {
      token: bearer ?? "",
      clientId: resolved.workspaceId,
      scopes: [],
      extra: { workspaceId: resolved.workspaceId },
    };
  },
  { required: true }
);

export { authed as GET, authed as POST, authed as DELETE };
