import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, signUpTestUser } from "./helpers";
import { agentJobs } from "@/lib/db/schema";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";
import { cancelJob, claimJob, completeJob, failJob, getJob, listJobs, retryJob } from "@/lib/jobs";
import {
  listComments, createComment, createVoiceComment, updateComment, deleteComment,
  getCommentAudio, MAX_AUDIO_BYTES, MAX_COMMENT_BODY_LENGTH,
} from "@/lib/comments";

async function contentIn(ws: { workspaceId: string }) {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage à commenter.", authorType: "user" });
  return contentId;
}

describe("commentaires — texte", () => {
  it("crée, liste (plus anciens d'abord), met à jour, supprime ; cloisonné", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const c1 = await createComment(ws.workspaceId, { contentId, body: "trop long", quote: "passage", prefix: "Un ", suffix: " à commenter", createdBy: "u1" });
    expect(c1.kind).toBe("text");
    expect(c1.status).toBe("open");
    const c2 = await createComment(ws.workspaceId, { contentId, body: "remarque générale" });
    expect(c2.quote).toBe("");
    expect((await listComments(ws.workspaceId, contentId, {})).map((c) => c.id)).toEqual([c1.id, c2.id]);
    const up = await updateComment(ws.workspaceId, c1.id, { status: "resolved", body: "finalement ok" });
    expect(up!.status).toBe("resolved");
    expect((await listComments(ws.workspaceId, contentId, { status: "open" })).map((c) => c.id)).toEqual([c2.id]);
    expect(await deleteComment(ws.workspaceId, c2.id)).toBe(true);
    const b = await signUpTestUser();
    expect(await listComments(b.workspaceId, contentId, {})).toHaveLength(0);
    expect(await updateComment(b.workspaceId, c1.id, { status: "open" })).toBeNull();
    expect(await deleteComment(b.workspaceId, c1.id)).toBe(false);
    await expect(createComment(b.workspaceId, { contentId, body: "intrus" })).rejects.toThrow(/introuvable/);
  });

  it("bornes : body vide ou > 10 000, quote > 2 000 → erreur", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    await expect(createComment(ws.workspaceId, { contentId, body: "  " })).rejects.toThrow(/body requis/);
    await expect(createComment(ws.workspaceId, { contentId, body: "x".repeat(MAX_COMMENT_BODY_LENGTH + 1) })).rejects.toThrow(/trop long/);
    await expect(createComment(ws.workspaceId, { contentId, body: "ok", quote: "q".repeat(2001) })).rejects.toThrow(/quote trop long/);
  });

  it("émet comment.updated à la création et à la mise à jour", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const seen: WorkspaceEvent[] = [];
    const un = bus.subscribe(ws.workspaceId, (e) => { if (e.type === "comment.updated") seen.push(e); });
    const c = await createComment(ws.workspaceId, { contentId, body: "x" });
    await updateComment(ws.workspaceId, c.id, { status: "applied" });
    un();
    expect(seen).toHaveLength(2);
    expect((seen[1] as { status: string }).status).toBe("applied");
  });
});

describe("commentaires — dictée", () => {
  it("createVoiceComment : commentaire voice pending + audio stocké + job transcribe queued", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, {
      contentId, audio: Buffer.from("fake-webm"), mime: "audio/webm", quote: "passage", prefix: "Un ", suffix: " à",
    });
    expect(comment.kind).toBe("voice");
    expect(comment.transcription).toBe("pending");
    expect(comment.body).toBe("");
    expect(job.kind).toBe("transcribe");
    expect(job.targetType).toBe("comment");
    expect(job.targetId).toBe(comment.id);
    const audio = await getCommentAudio(ws.workspaceId, comment.id);
    expect(audio!.mime).toBe("audio/webm");
    expect(audio!.bytes.toString()).toBe("fake-webm");
    const b = await signUpTestUser();
    expect(await getCommentAudio(b.workspaceId, comment.id)).toBeNull();
  });

  it("refuse un audio vide, > 16 Mo, ou d'un mime inconnu", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.alloc(0), mime: "audio/webm" })).rejects.toThrow(/audio vide/);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mime: "audio/webm" })).rejects.toThrow(/trop gros/);
    await expect(createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("x"), mime: "video/mp4" })).rejects.toThrow(/mime/);
  });

  it("complete_job({text}) remplit le commentaire, passe done, purge l'audio ; fail_job → failed, audio conservé ; retry repart", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "whisper indisponible");
    let c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("failed");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).not.toBeNull();
    await retryJob(ws.workspaceId, job.id);
    await claimJob(ws.workspaceId, job.id, "w");
    await completeJob(ws.workspaceId, job.id, { text: "Raccourcis ce paragraphe." });
    c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("done");
    expect(c.body).toBe("Raccourcis ce paragraphe.");
    expect(c.status).toBe("open");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).toBeNull();
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("done");
  });

  it("complete_job sans text sur un transcribe → le job échoue proprement (failed) au lieu de laisser le commentaire pending", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await claimJob(ws.workspaceId, job.id, "w");
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/text requis/);
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("running");
  });

  it("worker mort (silence > 10 min) sur un transcribe → transcription failed, audio conservé (balayage déclenché par listJobs)", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await claimJob(ws.workspaceId, job.id, "w");
    // on recule artificiellement le dernier battement de 11 min (même pattern que jobs.test.ts)
    await db.update(agentJobs)
      .set({ lastHeartbeatAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(agentJobs.id, job.id));
    await listJobs(ws.workspaceId, {});
    const c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("failed");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).not.toBeNull();
  });

  it("annulation d'un job transcribe queued → transcription failed (affordance « Réessayer »)", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { comment, job } = await createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" });
    await cancelJob(ws.workspaceId, job.id);
    const c = (await listComments(ws.workspaceId, contentId, {}))[0];
    expect(c.transcription).toBe("failed");
    expect(await getCommentAudio(ws.workspaceId, comment.id)).not.toBeNull();
  });
});
