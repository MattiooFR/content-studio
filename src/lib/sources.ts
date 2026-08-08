import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { sources, ideas } from "@/lib/db/schema";

type SourceKind = "url" | "pdf" | "audio" | "video" | "text";
type SourceStatus = "pending" | "extracted" | "failed";

type AddSourceInput = {
  ideaId: string; kind: SourceKind; ref: string;
  title?: string; rawExcerpt?: string; createdBy?: string;
};

// v1 : storage S3 pas encore branché (cf. register_asset). Seuls url/text
// peuvent être stockés sans upload binaire — pdf/audio/video arriveront
// avec la table assets réelle.
const AVAILABLE_KINDS_V1: SourceKind[] = ["url", "text"];

// Bornes de durcissement DoS (même style que gauges.ts : MAX_NAME_LENGTH,
// MAX_URL_LENGTH…) — exportées pour que /api/clip (qui écrit directement en
// base, sans passer par addSource) applique les MÊMES bornes plutôt que
// des constantes dupliquées. Une valeur hors bornes est une entrée CASSÉE
// (error/400), jamais tronquée en silence.
export const MAX_SOURCE_TITLE_LENGTH = 300;
export const MAX_SOURCE_EXCERPT_LENGTH = 10000;
export const MAX_SOURCE_REF_LENGTH = 2000;

export async function addSource(workspaceId: string, input: AddSourceInput) {
  if (!AVAILABLE_KINDS_V1.includes(input.kind)) {
    throw new Error("kind non disponible en v1");
  }
  if (input.ref.length > MAX_SOURCE_REF_LENGTH) {
    throw new Error(`ref trop long (max ${MAX_SOURCE_REF_LENGTH} caractères)`);
  }
  if (input.title !== undefined && input.title.length > MAX_SOURCE_TITLE_LENGTH) {
    throw new Error(`title trop long (max ${MAX_SOURCE_TITLE_LENGTH} caractères)`);
  }
  if (input.rawExcerpt !== undefined && input.rawExcerpt.length > MAX_SOURCE_EXCERPT_LENGTH) {
    throw new Error(`rawExcerpt trop long (max ${MAX_SOURCE_EXCERPT_LENGTH} caractères)`);
  }
  // kind "url" : schéma validé ICI, au niveau lib — couvre UI + MCP + le futur
  // /api/clip (W4) d'un coup, une seule règle. Sans ça, `javascript:`/`data:`
  // seraient stockés tels quels : pas de XSS aujourd'hui (jamais rendu en
  // href), mais différée dès qu'un écran ouvre la source.
  if (input.kind === "url") {
    let parsed: URL;
    try {
      parsed = new URL(input.ref);
    } catch {
      throw new Error("URL invalide (http/https attendu)");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL invalide (http/https attendu)");
    }
  }
  const [idea] = await db.select().from(ideas)
    .where(and(eq(ideas.id, input.ideaId), eq(ideas.workspaceId, workspaceId)));
  if (!idea) throw new Error("idée introuvable dans ce workspace");

  const values: Record<string, unknown> = {
    workspaceId, ideaId: input.ideaId, kind: input.kind, ref: input.ref,
  };
  if (input.title !== undefined) values.title = input.title;
  if (input.rawExcerpt !== undefined) values.rawExcerpt = input.rawExcerpt;
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;

  const [row] = await db.insert(sources).values(values as any).returning();
  return row;
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
