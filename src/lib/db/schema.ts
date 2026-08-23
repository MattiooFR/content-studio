import {
  pgTable, text, timestamp, uuid, jsonb, boolean, integer,
  uniqueIndex, index,
} from "drizzle-orm/pg-core";

// ---- better-auth (shape exigée par l'adapter drizzle de better-auth) ----
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// ---- domaine (workspace_id NOT NULL partout) ----
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memberships = pgTable("memberships", {
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
}, (t) => [uniqueIndex("memberships_ws_user").on(t.workspaceId, t.userId)]);

export const mcpTokens = pgTable("mcp_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  prefix: text("prefix").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ideas = pgTable("ideas", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  sourceUrl: text("source_url"),
  tags: text("tags").array().notNull().default([]),
  status: text("status", { enum: ["inbox", "in_progress", "done", "archived"] })
    .notNull().default("inbox"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("ideas_ws").on(t.workspaceId)]);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  name: text("name").notNull(),
  outputType: text("output_type", { enum: ["text", "image", "video"] })
    .notNull().default("text"),
  constraints: jsonb("constraints").notNull().default({}),
}, (t) => [uniqueIndex("channels_ws_key").on(t.workspaceId, t.key)]);

export const personas = pgTable("personas", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  voice: text("voice").notNull().default(""),
  audience: text("audience").notNull().default(""),
  language: text("language").notNull().default("fr"),
});

export const artDirections = pgTable("art_directions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  palette: jsonb("palette").notNull().default({}),
  stylePrompt: text("style_prompt").notNull().default(""),
  referenceAssetIds: uuid("reference_asset_ids").array().notNull().default([]),
  voices: jsonb("voices").notNull().default({}),
  visualPersonas: jsonb("visual_personas").notNull().default({}),
});

export const contents = pgTable("contents", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id").notNull()
    .references(() => ideas.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id").notNull()
    .references(() => channels.id, { onDelete: "restrict" }),
  personaId: uuid("persona_id").references(() => personas.id, { onDelete: "set null" }),
  artDirectionId: uuid("art_direction_id")
    .references(() => artDirections.id, { onDelete: "set null" }),
  type: text("type", { enum: ["text", "image", "video"] }).notNull().default("text"),
  status: text("status", {
    enum: ["draft", "review", "approved", "published", "generating", "rejected"],
  }).notNull().default("draft"),
  body: text("body").notNull().default(""),
  assetId: uuid("asset_id"),
  // uuid volontairement SANS FK : cycle contents <-> content_revisions
  currentRevisionId: uuid("current_revision_id"),
  editingUntil: timestamp("editing_until"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("contents_ws").on(t.workspaceId), index("contents_idea").on(t.ideaId)]);

export const contentRevisions = pgTable("content_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentId: uuid("content_id").notNull()
    .references(() => contents.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  authorType: text("author_type", { enum: ["agent", "user"] }).notNull(),
  authorLabel: text("author_label").notNull().default(""),
  state: text("state", { enum: ["current", "superseded", "proposed"] }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("revisions_content").on(t.contentId)]);

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id").notNull()
    .references(() => ideas.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["url", "pdf", "audio", "video", "text"] }).notNull(),
  ref: text("ref").notNull(),
  title: text("title").notNull().default(""),
  rawExcerpt: text("raw_excerpt").notNull().default(""),
  extractedText: text("extracted_text").notNull().default(""),
  extractedMeta: jsonb("extracted_meta").notNull().default({}),
  status: text("status", { enum: ["pending", "extracted", "failed"] })
    .notNull().default("pending"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("sources_ws").on(t.workspaceId), index("sources_idea").on(t.ideaId)]);

export const gaugeSources = pgTable("gauge_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  headers: jsonb("headers").notNull().default({}),
  kind: text("kind", { enum: ["quota", "cost"] }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lastPayload: jsonb("last_payload").notNull().default({}),
  lastFetchedAt: timestamp("last_fetched_at"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("gauge_sources_ws").on(t.workspaceId)]);

// ---- lanes de chat (Task W10) --------------------------------------------
// Une lane = un onglet de conversation avec le CLI agent LOCAL de
// l'utilisateur (son abonnement, jamais un appel de modèle fait par
// l'outil). cliSessionId permet la reprise (`--resume`) d'une conversation
// déjà entamée côté CLI.
export const chatLanes = pgTable("chat_lanes", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("Conversation"),
  cliSessionId: text("cli_session_id"),
  status: text("status", { enum: ["idle", "running", "error"] })
    .notNull().default("idle"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("chat_lanes_ws").on(t.workspaceId)]);

// Pas de workspace_id ici (même pattern que content_revisions) : le
// cloisonnement passe par la lane parente (chat_lanes.workspace_id),
// jamais vérifié directement sur cette table — toute lib qui la lit DOIT
// d'abord charger la lane scopée au workspace.
export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  laneId: uuid("lane_id").notNull()
    .references(() => chatLanes.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "agent", "system"] }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [index("chat_messages_lane").on(t.laneId)]);

// Réglages par workspace pour les lanes. laneCommand est TOUJOURS
// configurable ici, jamais en dur dans le code : c'est la commande CLI de
// l'utilisateur (son abonnement), le serveur ne fait qu'orchestrer.
export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid("workspace_id").primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  laneCommand: text("lane_command").notNull()
    .default("claude -p --output-format stream-json --verbose"),
});

// ---- jobs (vague « cockpit agent ») ------------------------------------
// Une demande de travail posée par l'humain (bouton) ou par une règle de
// l'outil (hook), consommée par un worker EXTERNE via MCP. L'outil n'exécute
// rien : il consigne, cloisonne, notifie. target_id n'a pas de FK (trois
// tables cibles) : la lib vérifie la cible dans CE workspace à la création.
export const agentJobs = pgTable("agent_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  targetType: text("target_type", { enum: ["idea", "content", "comment"] }).notNull(),
  targetId: uuid("target_id").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status", { enum: ["queued", "running", "done", "failed", "cancelled"] })
    .notNull().default("queued"),
  result: jsonb("result").notNull().default({}),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  requestedBy: text("requested_by"),
  claimedBy: text("claimed_by"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
}, (t) => [
  index("agent_jobs_ws_status").on(t.workspaceId, t.status),
  index("agent_jobs_target").on(t.workspaceId, t.targetType, t.targetId),
]);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["image", "video", "audio"] }).notNull(),
  storageKey: text("storage_key").notNull(),
  mime: text("mime").notNull(),
  bytes: integer("bytes").notNull().default(0),
  meta: jsonb("meta").notNull().default({}),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
