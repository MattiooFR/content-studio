import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import {
  createDictation, getDictation, getDictationAudio, listDictations, applyDictation,
  failDictation, consumeDictation, retryDictation, deleteDictation,
  MAX_FIELD_KEY_LENGTH, MAX_DICTATION_TEXT_LENGTH,
} from "@/lib/dictations";
import { claimJob, completeJob, failJob, cancelJob, listJobs } from "@/lib/jobs";
import { bus, type WorkspaceEvent } from "@/lib/events";

const audio = () => Buffer.from("fake-opus-bytes");

describe("dictations — création et bornes", () => {
  it("createDictation : ligne pending + audio + job transcribe ciblant la dictée", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, {
      audio: audio(), mime: "audio/webm;codecs=opus", fieldKey: "idea:42:notes", createdBy: ws.userId,
    });
    expect(dictation.status).toBe("pending");
    expect(dictation.fieldKey).toBe("idea:42:notes");
    expect(job.kind).toBe("transcribe");
    expect(job.targetType).toBe("dictation");
    expect(job.targetId).toBe(dictation.id);
    expect(job.payload).toMatchObject({ field_key: "idea:42:notes", mime: "audio/webm;codecs=opus", size: audio().length });
    const stored = await getDictationAudio(ws.workspaceId, dictation.id);
    expect(stored?.size).toBe(audio().length);
    expect(stored?.mime).toBe("audio/webm;codecs=opus");
  });

  it("refuse audio vide, trop gros, mime inconnu, field_key trop long", async () => {
    const ws = await signUpTestUser();
    await expect(createDictation(ws.workspaceId, { audio: Buffer.alloc(0), mime: "audio/webm" })).rejects.toThrow(/audio vide/);
    await expect(createDictation(ws.workspaceId, { audio: Buffer.alloc(16 * 1024 * 1024 + 1), mime: "audio/webm" })).rejects.toThrow(/trop gros/);
    await expect(createDictation(ws.workspaceId, { audio: audio(), mime: "text/plain" })).rejects.toThrow(/mime audio non supporté/);
    await expect(createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k".repeat(MAX_FIELD_KEY_LENGTH + 1) })).rejects.toThrow(/field_key trop long/);
  });
});

describe("dictations — cycle transcribe", () => {
  it("complete_job avec result.text → done, texte posé, audio purgé ; sans text → refusé", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "f" });
    await claimJob(ws.workspaceId, job.id, "test-worker");
    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/result.text requis/);
    const done = await completeJob(ws.workspaceId, job.id, { text: "Bonjour, ceci est une dictée." });
    expect(done?.status).toBe("done");
    const d = await getDictation(ws.workspaceId, dictation.id);
    expect(d?.status).toBe("done");
    expect(d?.text).toBe("Bonjour, ceci est une dictée.");
    expect(await getDictationAudio(ws.workspaceId, dictation.id)).toBeNull();
  });

  it("fail_job / cancel_job → failed avec raison, audio conservé ; jamais sur une dictée done", async () => {
    const ws = await signUpTestUser();
    const a = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "a" });
    await claimJob(ws.workspaceId, a.job.id, "w");
    await failJob(ws.workspaceId, a.job.id, "ffmpeg absent");
    const fa = await getDictation(ws.workspaceId, a.dictation.id);
    expect(fa?.status).toBe("failed");
    expect(fa?.error).toBe("ffmpeg absent");
    expect(await getDictationAudio(ws.workspaceId, a.dictation.id)).not.toBeNull();

    const b = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "b" });
    await cancelJob(ws.workspaceId, b.job.id);
    expect((await getDictation(ws.workspaceId, b.dictation.id))?.status).toBe("failed");

    await applyDictation(ws.workspaceId, b.dictation.id, "texte");
    expect(await failDictation(ws.workspaceId, b.dictation.id, "trop tard")).toBeNull();
    expect((await getDictation(ws.workspaceId, b.dictation.id))?.status).toBe("done");
  });

  it("complete_job d'un transcribe accepte un long transcript (> 64 Kio) mais refuse au-delà du plafond dédié", async () => {
    const ws = await signUpTestUser();
    const long = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "long" });
    await claimJob(ws.workspaceId, long.job.id, "w");
    const done = await completeJob(ws.workspaceId, long.job.id, { text: "mot ".repeat(37_500) }); // ~150 Ko
    expect(done?.status).toBe("done");
    expect((await getDictation(ws.workspaceId, long.dictation.id))?.text.length).toBe(150_000);

    const huge = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "huge" });
    await claimJob(ws.workspaceId, huge.job.id, "w");
    await expect(completeJob(ws.workspaceId, huge.job.id, { text: "x".repeat(600_000) })).rejects.toThrow(/result trop gros/);
  });

  it("applyDictation refuse un texte au-delà de MAX_DICTATION_TEXT_LENGTH", async () => {
    const ws = await signUpTestUser();
    const { dictation } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm" });
    await expect(applyDictation(ws.workspaceId, dictation.id, "x".repeat(MAX_DICTATION_TEXT_LENGTH + 1))).rejects.toThrow(/text trop long/);
  });

  it("retryDictation : failed → pending + job requeued (attempts+1) ; refus si non failed ; null si introuvable", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "r" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const retried = await retryDictation(ws.workspaceId, dictation.id);
    expect(retried?.status).toBe("pending");
    expect(retried?.error).toBeNull();
    const jobs = await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: dictation.id });
    expect(jobs[0].status).toBe("queued");
    expect(jobs[0].attempts).toBe(1);
    await expect(retryDictation(ws.workspaceId, dictation.id)).rejects.toThrow(/réessai refusé/);
    expect(await retryDictation(ws.workspaceId, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("consumeDictation idempotent ; listDictations open = pending + done non consommée du field_key", async () => {
    const ws = await signUpTestUser();
    const p = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const d = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const c = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "k" });
    const other = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "autre" });
    await applyDictation(ws.workspaceId, d.dictation.id, "prête");
    await applyDictation(ws.workspaceId, c.dictation.id, "déjà lue");
    const first = await consumeDictation(ws.workspaceId, c.dictation.id);
    const second = await consumeDictation(ws.workspaceId, c.dictation.id);
    expect(first?.consumedAt).not.toBeNull();
    expect(first?.first).toBe(true);
    expect(second?.consumedAt?.getTime()).toBe(first?.consumedAt?.getTime());
    expect(second?.first).toBe(false);

    const open = await listDictations(ws.workspaceId, { fieldKey: "k", open: true });
    expect(open.map((x) => x.id).sort()).toEqual([p.dictation.id, d.dictation.id].sort());
    expect((await listDictations(ws.workspaceId, { status: "pending" })).map((x) => x.id)).toContain(other.dictation.id);
    expect(await listDictations(ws.workspaceId, { limit: 2 })).toHaveLength(2);
    // jamais l'audio dans une liste
    expect("bytes" in open[0]).toBe(false);
  });

  it("deleteDictation : ligne + audio supprimés, job queued annulé, événement deleted", async () => {
    const ws = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "del" });
    const events: WorkspaceEvent[] = [];
    const off = bus.subscribe(ws.workspaceId, (e) => events.push(e));
    try {
      expect(await deleteDictation(ws.workspaceId, dictation.id)).toBe(true);
    } finally { off(); }
    expect(await getDictation(ws.workspaceId, dictation.id)).toBeNull();
    expect(await getDictationAudio(ws.workspaceId, dictation.id)).toBeNull();
    const [j] = await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: dictation.id });
    expect(j.status).toBe("cancelled");
    expect(events.some((e) => e.type === "dictation.updated" && e.status === "deleted" && e.dictationId === dictation.id)).toBe(true);
    expect(await deleteDictation(ws.workspaceId, dictation.id)).toBe(false);
  });
});

describe("dictations — cloisonnement workspace", () => {
  it("une dictée de A est invisible et intouchable depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const { dictation } = await createDictation(a.workspaceId, { audio: audio(), mime: "audio/webm", fieldKey: "x" });
    expect(await getDictation(b.workspaceId, dictation.id)).toBeNull();
    expect(await getDictationAudio(b.workspaceId, dictation.id)).toBeNull();
    expect(await applyDictation(b.workspaceId, dictation.id, "vol")).toBeNull();
    expect(await failDictation(b.workspaceId, dictation.id, "vol")).toBeNull();
    expect(await consumeDictation(b.workspaceId, dictation.id)).toBeNull();
    expect(await deleteDictation(b.workspaceId, dictation.id)).toBe(false);
    expect((await listDictations(b.workspaceId, {})).map((x) => x.id)).not.toContain(dictation.id);
  });
});
