import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { chatLanes, chatMessages, workspaceSettings } from "@/lib/db/schema";

// La commande CLI est TOUJOURS configurable (workspace_settings.laneCommand),
// jamais en dur ailleurs dans le code — ceci n'est qu'une valeur initiale.
export const DEFAULT_LANE_COMMAND = "claude -p --output-format stream-json --verbose";

const MAX_TITLE_LENGTH = 200;

export async function createLane(workspaceId: string, input: { title?: string } = {}) {
  if (input.title !== undefined && input.title.length > MAX_TITLE_LENGTH) {
    throw new Error(`title trop long (max ${MAX_TITLE_LENGTH} caractères)`);
  }
  const values: Record<string, unknown> = { workspaceId };
  // Titre optionnel : n'écrase le défaut "Conversation" que si une valeur
  // non vide est fournie (cf. createGaugeSource / addSource : champs
  // optionnels seulement posés quand définis, jamais un spread aveugle).
  if (input.title !== undefined && input.title.trim() !== "") values.title = input.title;
  const [row] = await db.insert(chatLanes).values(values as never).returning();
  return row;
}

export async function listLanes(workspaceId: string) {
  return db.select().from(chatLanes)
    .where(eq(chatLanes.workspaceId, workspaceId))
    .orderBy(asc(chatLanes.createdAt));
}

export async function getLane(workspaceId: string, laneId: string) {
  const [row] = await db.select().from(chatLanes)
    .where(and(eq(chatLanes.id, laneId), eq(chatLanes.workspaceId, workspaceId)));
  return row ?? null;
}

/**
 * Historique d'une lane. `null` si la lane n'existe pas DANS ce workspace —
 * jamais une simple requête sur chat_messages.lane_id seule, qui n'a pas de
 * workspace_id propre : le cloisonnement passe entièrement par ce contrôle
 * sur la lane parente avant de toucher aux messages.
 */
export async function getLaneMessages(workspaceId: string, laneId: string) {
  const lane = await getLane(workspaceId, laneId);
  if (!lane) return null;
  return db.select().from(chatMessages)
    .where(eq(chatMessages.laneId, laneId))
    .orderBy(asc(chatMessages.createdAt));
}

/**
 * Lit les réglages du workspace, en créant la ligne par défaut si elle
 * n'existe pas encore (aucun hook de création de workspace n'y touche :
 * la ligne apparaît paresseusement, au premier besoin réel).
 */
export async function getWorkspaceSettings(workspaceId: string) {
  const [existing] = await db.select().from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  if (existing) return existing;

  const [created] = await db.insert(workspaceSettings)
    .values({ workspaceId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Course rare : un autre appel concurrent a créé la ligne entre le SELECT
  // et l'INSERT ci-dessus (onConflictDoNothing ne rend alors rien) — on la
  // relit plutôt que de supposer qu'elle existe.
  const [row] = await db.select().from(workspaceSettings)
    .where(eq(workspaceSettings.workspaceId, workspaceId));
  return row;
}

export async function setLaneCommand(workspaceId: string, laneCommand: string) {
  if (!laneCommand.trim()) throw new Error("laneCommand requis");
  await getWorkspaceSettings(workspaceId); // garantit que la ligne existe déjà
  const [row] = await db.update(workspaceSettings)
    .set({ laneCommand })
    .where(eq(workspaceSettings.workspaceId, workspaceId))
    .returning();
  return row;
}
