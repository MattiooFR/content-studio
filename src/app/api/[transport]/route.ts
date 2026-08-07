import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { channels, artDirections } from "@/lib/db/schema";
import { resolveMcpToken } from "@/lib/tenant";
import { listIdeas, getIdea } from "@/lib/ideas";
import { listPersonas } from "@/lib/personas";
import {
  createContentDraft, getContent, applyContentUpdate, listContents,
} from "@/lib/contents";

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
        return json({
          idea,
          contents: contents.map((c) => ({
            id: c.id, channelId: c.channelId, type: c.type,
            status: c.status, updatedAt: c.updatedAt,
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
        description: "Écrit une nouvelle version du contenu (markdown complet, pas un diff). Si un humain est en train d'éditer, la version part en 'proposed' et lui est montrée en diff — c'est normal, ne pas ré-essayer.",
        inputSchema: { content_id: z.string().uuid(), body: z.string() },
      },
      async ({ content_id, body }, extra) =>
        json(await applyContentUpdate({
          workspaceId: wsOf(extra), contentId: content_id,
          body, authorType: "agent", authorLabel: "mcp",
        }))
    );

    server.registerTool(
      "register_asset",
      {
        description: "Réservé v1.1 : enregistrement d'assets (images/vidéos).",
        inputSchema: { kind: z.enum(["image", "video", "audio"]), mime: z.string() },
      },
      async () => json({ error: "register_asset arrive en v1.1 — v1 est texte uniquement" })
    );
  },
  {}
);

const authed = withMcpAuth(
  handler,
  async (_req, bearer) => {
    const resolved = await resolveMcpToken(bearer ? `Bearer ${bearer}` : null);
    if (!resolved) return undefined; // → 401
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
