import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { commentAudio, contentComments, contents } from "@/lib/db/schema";
import { bus } from "@/lib/events";
import { createJob, type Job } from "@/lib/jobs";

export type Comment = typeof contentComments.$inferSelect;
export const MAX_COMMENT_BODY_LENGTH = 10000;
export const MAX_QUOTE_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 200;
export const MAX_SECTION_LENGTH = 300;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const AUDIO_MIMES = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"];

type Anchor = { quote?: string; prefix?: string; suffix?: string; section?: string };

function publish(c: Comment) {
  bus.publish(c.workspaceId, {
    type: "comment.updated", contentId: c.contentId, commentId: c.id,
    status: c.status, transcription: c.transcription,
  });
}

async function assertContent(workspaceId: string, contentId: string) {
  const [row] = await db.select({ id: contents.id }).from(contents)
    .where(and(eq(contents.id, contentId), eq(contents.workspaceId, workspaceId)));
  if (!row) throw new Error("content introuvable dans ce workspace");
}

function checkAnchor(a: Anchor) {
  if (a.quote !== undefined && a.quote.length > MAX_QUOTE_LENGTH) throw new Error(`quote trop long (max ${MAX_QUOTE_LENGTH} caractères)`);
  for (const k of ["prefix", "suffix"] as const)
    if (a[k] !== undefined && a[k]!.length > MAX_CONTEXT_LENGTH) throw new Error(`${k} trop long (max ${MAX_CONTEXT_LENGTH} caractères)`);
  if (a.section !== undefined && a.section.length > MAX_SECTION_LENGTH) throw new Error(`section trop long (max ${MAX_SECTION_LENGTH} caractères)`);
}

function anchorValues(a: Anchor): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (a.quote !== undefined) v.quote = a.quote;
  if (a.prefix !== undefined) v.prefix = a.prefix;
  if (a.suffix !== undefined) v.suffix = a.suffix;
  if (a.section !== undefined) v.section = a.section;
  return v;
}

export async function listComments(workspaceId: string, contentId: string, filter: { status?: "open" | "applied" | "resolved" }) {
  const conds = [eq(contentComments.workspaceId, workspaceId), eq(contentComments.contentId, contentId)];
  if (filter.status) conds.push(eq(contentComments.status, filter.status));
  return db.select().from(contentComments).where(and(...conds)).orderBy(asc(contentComments.createdAt));
}

export async function getComment(workspaceId: string, id: string) {
  const [row] = await db.select().from(contentComments)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId)));
  return row ?? null;
}

export async function createComment(workspaceId: string, input: Anchor & { contentId: string; body: string; createdBy?: string }) {
  const body = input.body.trim();
  if (!body) throw new Error("body requis");
  if (body.length > MAX_COMMENT_BODY_LENGTH) throw new Error(`body trop long (max ${MAX_COMMENT_BODY_LENGTH} caractères)`);
  checkAnchor(input);
  await assertContent(workspaceId, input.contentId);
  const values: Record<string, unknown> = { workspaceId, contentId: input.contentId, body, kind: "text", ...anchorValues(input) };
  if (input.createdBy !== undefined) values.createdBy = input.createdBy;
  const [row] = await db.insert(contentComments).values(values as never).returning();
  publish(row);
  return row;
}

export async function createVoiceComment(workspaceId: string, input: Anchor & {
  contentId: string; audio: Buffer; mime: string; createdBy?: string;
}): Promise<{ comment: Comment; job: Job }> {
  if (!input.audio.length) throw new Error("audio vide");
  if (input.audio.length > MAX_AUDIO_BYTES) throw new Error(`audio trop gros (max ${MAX_AUDIO_BYTES} octets)`);
  const mime = input.mime.split(";")[0].trim();
  if (!AUDIO_MIMES.some((m) => m.split(";")[0] === mime)) throw new Error(`mime audio non supporté : ${input.mime}`);
  checkAnchor(input);
  await assertContent(workspaceId, input.contentId);
  const comment = await db.transaction(async (tx) => {
    const values: Record<string, unknown> = {
      workspaceId, contentId: input.contentId, body: "", kind: "voice", transcription: "pending", ...anchorValues(input),
    };
    if (input.createdBy !== undefined) values.createdBy = input.createdBy;
    const [row] = await tx.insert(contentComments).values(values as never).returning();
    await tx.insert(commentAudio).values({ commentId: row.id, mime: input.mime, bytes: input.audio, size: input.audio.length });
    return row;
  });
  publish(comment);
  // createJob possède sa propre transaction + verrou avisé : elle reste hors
  // de celle du commentaire/audio ci-dessus. Mais si elle échoue (payload
  // refusé, DB indisponible…), le commentaire ne doit pas rester « pending »
  // sans job et sans recours : on le bascule en « failed » (visible, audio
  // conservé, « Réessayer » possible) avant de propager l'erreur.
  let job: Job;
  try {
    ({ job } = await createJob(workspaceId, {
      kind: "transcribe", targetType: "comment", targetId: comment.id,
      payload: { content_id: input.contentId, mime: input.mime, size: input.audio.length },
      requestedBy: input.createdBy ? `user:${input.createdBy}` : "system:voice-comment",
    }));
  } catch (e) {
    await failTranscription(workspaceId, comment.id);
    throw e;
  }
  return { comment, job };
}

export async function updateComment(workspaceId: string, id: string, patch: { body?: string; status?: "open" | "applied" | "resolved" }) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.body !== undefined) {
    if (patch.body.length > MAX_COMMENT_BODY_LENGTH) throw new Error(`body trop long (max ${MAX_COMMENT_BODY_LENGTH} caractères)`);
    set.body = patch.body;
  }
  if (patch.status !== undefined) set.status = patch.status;
  const [row] = await db.update(contentComments).set(set as never)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId))).returning();
  if (row) publish(row);
  return row ?? null;
}

export async function deleteComment(workspaceId: string, id: string): Promise<boolean> {
  // `.returning()` complet (et non le seul id) : il faut la ligne supprimée
  // pour publier l'événement. Sans lui, tout abonné qui n'a pas déclenché la
  // suppression lui-même restait sur une liste périmée — le compteur de
  // l'onglet « Relire » et l'activation d'« Appliquer les commentaires »
  // gardaient un commentaire qui n'existe plus (revue Task 15, finding I2).
  const [row] = await db.delete(contentComments)
    .where(and(eq(contentComments.id, id), eq(contentComments.workspaceId, workspaceId))).returning();
  if (!row) return false;
  // On réémet `comment.updated` avec le DERNIER statut connu de la ligne
  // supprimée, pas un statut « deleted » : l'union d'événements reste telle
  // quelle, et les consommateurs se contentent de re-lister — la disparition
  // se lit dans la réponse du GET, pas dans l'événement.
  publish(row);
  return true;
}

/** Cloisonné par le commentaire parent (comment_audio n'a pas de workspace_id). */
export async function getCommentAudio(workspaceId: string, commentId: string) {
  const c = await getComment(workspaceId, commentId);
  if (!c) return null;
  const [row] = await db.select().from(commentAudio).where(eq(commentAudio.commentId, commentId));
  return row ? { mime: row.mime, bytes: Buffer.from(row.bytes) } : null;
}

export async function purgeCommentAudio(commentId: string) {
  await db.delete(commentAudio).where(eq(commentAudio.commentId, commentId));
}

/** Effets de complétion/échec d'un job transcribe — appelés par jobs.ts. */
export async function applyTranscription(workspaceId: string, commentId: string, text: string) {
  const [row] = await db.update(contentComments)
    .set({ body: text.slice(0, MAX_COMMENT_BODY_LENGTH), transcription: "done", updatedAt: new Date() })
    .where(and(eq(contentComments.id, commentId), eq(contentComments.workspaceId, workspaceId))).returning();
  if (!row) return null;
  await purgeCommentAudio(commentId);
  publish(row);
  return row;
}

export async function failTranscription(workspaceId: string, commentId: string) {
  const [row] = await db.update(contentComments)
    .set({ transcription: "failed", updatedAt: new Date() })
    .where(and(eq(contentComments.id, commentId), eq(contentComments.workspaceId, workspaceId))).returning();
  if (row) publish(row);
  return row ?? null;
}
