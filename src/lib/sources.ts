import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sources, ideas } from "@/lib/db/schema";
import { youtubeVideoId } from "@/lib/youtube";
import { createJob } from "@/lib/jobs";

type SourceKind = "url" | "pdf" | "audio" | "video" | "text";
type SourceStatus = "pending" | "extracted" | "failed";

type AddSourceInput = {
  ideaId: string; kind: SourceKind; ref?: string; text?: string;
  title?: string; rawExcerpt?: string; createdBy?: string;
};

// url/text stockés tels quels ; video = URL YouTube uniquement (le worker
// télécharge l'audio en local, aucun binaire côté outil). pdf/audio (upload)
// attendent la table assets.
const AVAILABLE_KINDS: SourceKind[] = ["url", "text", "video"];

// Bornes de durcissement DoS (même style que gauges.ts : MAX_NAME_LENGTH,
// MAX_URL_LENGTH…) — exportées pour que /api/clip (qui écrit directement en
// base, sans passer par addSource) applique les MÊMES bornes plutôt que
// des constantes dupliquées. Une valeur hors bornes est une entrée CASSÉE
// (error/400), jamais tronquée en silence.
export const MAX_SOURCE_TITLE_LENGTH = 300;
export const MAX_SOURCE_EXCERPT_LENGTH = 10000;
export const MAX_SOURCE_REF_LENGTH = 2000;
// kind text : le contenu part directement dans extracted_text (aucune
// extraction à faire) — borne dédiée, bien au-dessus de ref.
export const MAX_SOURCE_TEXT_LENGTH = 200_000;
// attachExtraction (~25 h de transcript). Hors borne = entrée CASSÉE (throw),
// jamais tronquée en silence — même règle que les autres bornes.
export const MAX_SOURCE_EXTRACTED_LENGTH = 1_500_000;

export async function addSource(workspaceId: string, input: AddSourceInput) {
  let kind = input.kind;
  if (!AVAILABLE_KINDS.includes(kind)) {
    throw new Error("kind non disponible (pdf/audio attendent la table assets)");
  }
  if (input.title !== undefined && input.title.length > MAX_SOURCE_TITLE_LENGTH) {
    throw new Error(`title trop long (max ${MAX_SOURCE_TITLE_LENGTH} caractères)`);
  }
  if (input.rawExcerpt !== undefined && input.rawExcerpt.length > MAX_SOURCE_EXCERPT_LENGTH) {
    throw new Error(`rawExcerpt trop long (max ${MAX_SOURCE_EXCERPT_LENGTH} caractères)`);
  }

  let ref = input.ref ?? "";
  let extractedText: string | null = null; // non-null ⇒ extracted d'emblée (kind text)

  if (kind === "text") {
    // Contenu par `text` (champ dédié, long) ou par `ref` (compat MCP et
    // anciens appelants — un collage court passait par là).
    const content = input.text ?? input.ref;
    if (!content || !content.trim()) throw new Error("text requis pour kind text");
    if (content.length > MAX_SOURCE_TEXT_LENGTH) {
      throw new Error(`text trop long (max ${MAX_SOURCE_TEXT_LENGTH} caractères)`);
    }
    extractedText = content;
    // ref devient une étiquette : première ligne non vide, tronquée à 120.
    const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "texte collé";
    ref = firstLine.slice(0, 120);
  } else {
    if (!ref) throw new Error("ref requis");
    if (ref.length > MAX_SOURCE_REF_LENGTH) {
      throw new Error(`ref trop long (max ${MAX_SOURCE_REF_LENGTH} caractères)`);
    }
    // kind url/video : schéma validé ICI, au niveau lib — couvre UI + MCP
    // d'un coup. Sans ça, `javascript:`/`data:` seraient stockés tels quels.
    let parsed: URL;
    try {
      parsed = new URL(ref);
    } catch {
      throw new Error("URL invalide (http/https attendu)");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL invalide (http/https attendu)");
    }
    // Une URL YouTube déposée en `url` est reclassée `video` ; un `video`
    // explicite DOIT être une URL YouTube reconnue (pas d'autre vidéo en v1.1).
    if (kind === "url" && youtubeVideoId(ref)) kind = "video";
    if (kind === "video" && !youtubeVideoId(ref)) {
      throw new Error("kind video : URL YouTube attendue (watch, shorts, youtu.be)");
    }
  }

  const [idea] = await db.select().from(ideas)
    .where(and(eq(ideas.id, input.ideaId), eq(ideas.workspaceId, workspaceId)));
  if (!idea) throw new Error("idée introuvable dans ce workspace");

  const values: Record<string, unknown> = {
    workspaceId, ideaId: input.ideaId, kind, ref,
  };
  if (extractedText !== null) {
    values.extractedText = extractedText;
    values.status = "extracted";
  }
  if (input.title !== undefined) values.title = input.title;
  if (input.rawExcerpt !== undefined) values.rawExcerpt = input.rawExcerpt;
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;

  const [row] = await db.insert(sources).values(values as any).returning();
  if (row.status === "pending") await enqueueExtractJob(workspaceId, row);
  return row;
}

/**
 * Pose le job `extract` d'une source pending. Non bloquant : la source existe
 * déjà, un échec ici la laisse en pending (le bouton Réessayer couvre) — même
 * philosophie que les effets post-commit de jobs.ts. Exporté pour /api/clip,
 * qui insère ses sources en direct (transaction idée+source) sans addSource.
 */
export async function enqueueExtractJob(
  workspaceId: string,
  source: { id: string; kind: string; ref: string; createdBy?: string | null },
): Promise<void> {
  try {
    await createJob(workspaceId, {
      kind: "extract", targetType: "source", targetId: source.id,
      payload: { source_kind: source.kind, ref: source.ref },
      requestedBy: source.createdBy ?? "system:extract",
    });
  } catch (e) {
    console.error("création du job extract impossible (source laissée pending)", e);
  }
}

export async function listSources(
  workspaceId: string,
  filter: { ideaId?: string; status?: SourceStatus }
) {
  const conditions = [eq(sources.workspaceId, workspaceId)];
  if (filter.ideaId !== undefined) conditions.push(eq(sources.ideaId, filter.ideaId));
  if (filter.status !== undefined) conditions.push(eq(sources.status, filter.status));
  return db.select().from(sources)
    .where(and(...conditions))
    .orderBy(desc(sources.createdAt));
}

export async function getSource(workspaceId: string, id: string) {
  const [row] = await db.select().from(sources)
    .where(and(eq(sources.id, id), eq(sources.workspaceId, workspaceId)));
  return row ?? null;
}

export async function attachExtraction(
  workspaceId: string, sourceId: string,
  input: { extractedText: string; extractedMeta?: Record<string, unknown> }
) {
  const update: Record<string, unknown> = {
    status: "extracted",
    extractedText: input.extractedText,
    updatedAt: new Date(),
  };
  if (input.extractedMeta !== undefined) update.extractedMeta = input.extractedMeta;

  const [row] = await db.update(sources)
    .set(update as any)
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}

export async function markSourceFailed(workspaceId: string, sourceId: string, reason: string) {
  const [row] = await db.update(sources)
    .set({ status: "failed", extractedMeta: { error: reason }, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.workspaceId, workspaceId)))
    .returning();
  return row ?? null;
}
