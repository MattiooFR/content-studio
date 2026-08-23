import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, signUpTestUser } from "./helpers";
import { agentJobs } from "@/lib/db/schema";
import { createIdea } from "@/lib/ideas";
import { createContentDraft } from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";
import {
  createJob, listJobs, getJob, claimJob, heartbeatJob, completeJob, failJob,
  retryJob, cancelJob, sweepSilentJobs, JobStateError,
  MAX_JOB_ERROR_LENGTH, MAX_JOB_JSON_BYTES,
} from "@/lib/jobs";

async function ideaIn(ws: { workspaceId: string }) {
  return createIdea(ws.workspaceId, { title: "Idée pour job" });
}

describe("jobs — création et unicité", () => {
  it("crée un job queued sur une idée du workspace", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job, created } = await createJob(ws.workspaceId, {
      kind: "write", targetType: "idea", targetId: idea.id,
      payload: { channel_key: "community" }, requestedBy: "user:test",
    });
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("write");
    expect(job.payload).toEqual({ channel_key: "community" });
    expect(job.attempts).toBe(0);
  });

  it("refuse une cible d'un autre workspace ou inexistante", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const ideaB = await ideaIn(b);
    await expect(createJob(a.workspaceId, { kind: "write", targetType: "idea", targetId: ideaB.id }))
      .rejects.toThrow(/introuvable/);
    await expect(createJob(a.workspaceId, { kind: "write", targetType: "content", targetId: crypto.randomUUID() }))
      .rejects.toThrow(/introuvable/);
  });

  it("sans coalesce : un job actif existant est rendu, rien n'est créé", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const first = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const second = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    // même après claim (running), toujours pas de doublon
    await claimJob(ws.workspaceId, first.job.id, "w1");
    const third = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(third.created).toBe(false);
    expect(third.job.id).toBe(first.job.id);
  });

  it("avec coalesce : un queued est rendu ; un running seul laisse créer UN queued", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const a = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    const b = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.job.id);
    await claimJob(ws.workspaceId, a.job.id, "w1");
    const c = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(c.created).toBe(true);
    expect(c.job.id).not.toBe(a.job.id);
    const d = await createJob(ws.workspaceId, { kind: "sync", targetType: "content", targetId: contentId, coalesce: true });
    expect(d.created).toBe(false);
    expect(d.job.id).toBe(c.job.id);
  });

  it("un kind différent sur la même cible n'est pas dédoublonné", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const w = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const x = await createJob(ws.workspaceId, { kind: "autre", targetType: "idea", targetId: idea.id });
    expect(x.created).toBe(true);
    expect(x.job.id).not.toBe(w.job.id);
  });

  it("bornes : kind vide ou payload > 64 Ko refusés", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    await expect(createJob(ws.workspaceId, { kind: "  ", targetType: "idea", targetId: idea.id }))
      .rejects.toThrow(/kind requis/);
    const gros = { blob: "x".repeat(MAX_JOB_JSON_BYTES + 1) };
    await expect(createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id, payload: gros }))
      .rejects.toThrow(/payload trop gros/);
  });
});

describe("jobs — cycle de vie", () => {
  it("claim atomique : deux claims concurrents, un seul gagnant", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const results = await Promise.allSettled([
      claimJob(ws.workspaceId, job.id, "w1"),
      claimJob(ws.workspaceId, job.id, "w2"),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const ko = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(ko).toHaveLength(1);
    expect((ko[0] as PromiseRejectedResult).reason).toBeInstanceOf(JobStateError);
    const claimed = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimJob>>>).value!;
    expect(claimed.status).toBe("running");
    expect(["w1", "w2"]).toContain(claimed.claimedBy);
    expect(claimed.startedAt).not.toBeNull();
    expect(claimed.lastHeartbeatAt).not.toBeNull();
  });

  it("claim d'un job d'un autre workspace → null (introuvable), jamais pris", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await ideaIn(a);
    const { job } = await createJob(a.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(await claimJob(b.workspaceId, job.id, "intrus")).toBeNull();
    expect((await getJob(a.workspaceId, job.id))!.status).toBe("queued");
  });

  it("complete depuis running → done avec result ; complete depuis queued → JobStateError", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toBeInstanceOf(JobStateError);
    await claimJob(ws.workspaceId, job.id, "w1");
    const done = await completeJob(ws.workspaceId, job.id, { content_id: "abc" });
    expect(done!.status).toBe("done");
    expect(done!.result).toEqual({ content_id: "abc" });
    expect(done!.finishedAt).not.toBeNull();
  });

  it("fail → failed avec erreur tronquée à 2 000 ; retry → queued, attempts+1, erreur archivée", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    const failed = await failJob(ws.workspaceId, job.id, "E".repeat(MAX_JOB_ERROR_LENGTH + 50));
    expect(failed!.status).toBe("failed");
    expect(failed!.error).toHaveLength(MAX_JOB_ERROR_LENGTH);
    const retried = await retryJob(ws.workspaceId, job.id);
    expect(retried!.status).toBe("queued");
    expect(retried!.attempts).toBe(1);
    expect(retried!.error).toBeNull();
    expect(retried!.claimedBy).toBeNull();
    expect((retried!.payload as { previous_errors: string[] }).previous_errors).toHaveLength(1);
    // retry d'un job non failed → JobStateError
    await expect(retryJob(ws.workspaceId, job.id)).rejects.toBeInstanceOf(JobStateError);
  });

  it("cancel : queued → cancelled ; running → JobStateError", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect((await cancelJob(ws.workspaceId, job.id))!.status).toBe("cancelled");
    const { job: j2 } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(j2.id).not.toBe(job.id); // cancelled n'est plus actif → nouveau job
    await claimJob(ws.workspaceId, j2.id, "w1");
    await expect(cancelJob(ws.workspaceId, j2.id)).rejects.toBeInstanceOf(JobStateError);
  });

  it("heartbeat met à jour lastHeartbeatAt ; silence > 10 min → failed « agent silencieux »", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    const before = (await getJob(ws.workspaceId, job.id))!.lastHeartbeatAt!;
    await new Promise((r) => setTimeout(r, 20));
    const hb = await heartbeatJob(ws.workspaceId, job.id);
    expect(hb!.lastHeartbeatAt!.getTime()).toBeGreaterThan(before.getTime());

    // on recule artificiellement le dernier battement de 11 min
    await db.update(agentJobs)
      .set({ lastHeartbeatAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(agentJobs.id, job.id));
    expect(await sweepSilentJobs(ws.workspaceId)).toBe(1);
    const after = await getJob(ws.workspaceId, job.id);
    expect(after!.status).toBe("failed");
    expect(after!.error).toMatch(/silencieux/);
    // listJobs balaie aussi : un second appel ne retrouve plus rien à basculer
    expect(await sweepSilentJobs(ws.workspaceId)).toBe(0);
  });

  it("listJobs : filtres, ordre, résumé de cible, balayage intégré", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Titre visible dans la liste" });
    const { job: j1 } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await new Promise((r) => setTimeout(r, 5));
    const { job: j2 } = await createJob(ws.workspaceId, { kind: "autre", targetType: "idea", targetId: idea.id });

    const asc = await listJobs(ws.workspaceId, { status: "queued", order: "asc" });
    expect(asc.map((j) => j.id)).toEqual([j1.id, j2.id]);
    expect(asc[0].targetTitle).toBe("Titre visible dans la liste");

    const desc = await listJobs(ws.workspaceId, { targetType: "idea", targetId: idea.id });
    expect(desc.map((j) => j.id)).toEqual([j2.id, j1.id]);

    expect(await listJobs(ws.workspaceId, { kind: "autre" })).toHaveLength(1);
    const autre = await signUpTestUser();
    expect(await listJobs(autre.workspaceId, {})).toHaveLength(0);
  });

  it("émet job.updated sur le bus à chaque transition, dans le bon workspace", async () => {
    const ws = await signUpTestUser();
    const idea = await ideaIn(ws);
    const seen: WorkspaceEvent[] = [];
    const un = bus.subscribe(ws.workspaceId, (e) => { if (e.type === "job.updated") seen.push(e); });
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await claimJob(ws.workspaceId, job.id, "w1");
    await completeJob(ws.workspaceId, job.id, {});
    un();
    expect(seen.map((e) => (e as { status: string }).status)).toEqual(["queued", "running", "done"]);
    expect((seen[0] as { jobId: string }).jobId).toBe(job.id);
  });
});
