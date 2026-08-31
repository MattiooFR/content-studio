import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { addSource, attachExtraction, getSource } from "@/lib/sources";
import { createJob, claimJob, completeJob, failJob, cancelJob, listJobs } from "@/lib/jobs";

describe("jobs — cible source", () => {
  it("createJob accepte targetType source ; cloisonnement ; targetTitle = titre sinon ref", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const idea = await createIdea(a.workspaceId, { title: "Idée" });
    const sansTitre = await addSource(a.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/sans-titre",
    });
    const avecTitre = await addSource(a.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/avec-titre", title: "Un article",
    });

    await expect(
      createJob(b.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id })
    ).rejects.toThrow("cible introuvable dans ce workspace");

    await createJob(a.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id });
    await createJob(a.workspaceId, { kind: "probe", targetType: "source", targetId: avecTitre.id });
    const j1 = await listJobs(a.workspaceId, { kind: "probe", targetType: "source", targetId: sansTitre.id });
    const j2 = await listJobs(a.workspaceId, { kind: "probe", targetType: "source", targetId: avecTitre.id });
    expect(j1[0].targetTitle).toBe("https://exemple.fr/sans-titre");
    expect(j2[0].targetTitle).toBe("Un article");
  });

  it("completeJob d'un extract refuse tant que la source n'est pas extraite", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/article",
    });
    const { job } = await createJob(ws.workspaceId, {
      kind: "extract", targetType: "source", targetId: source.id,
      payload: { source_kind: "url", ref: source.ref },
    });
    await claimJob(ws.workspaceId, job.id, "test-worker");

    await expect(completeJob(ws.workspaceId, job.id, {})).rejects.toThrow(/source non extraite/);

    await attachExtraction(ws.workspaceId, source.id, { extractedText: "texte extrait" });
    const done = await completeJob(ws.workspaceId, job.id, {});
    expect(done?.status).toBe("done");
  });

  it("fail_job / cancel_job d'un extract → la source passe failed avec la raison", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    const s1 = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://a.test/x" });
    const j1 = (await createJob(ws.workspaceId, { kind: "extract", targetType: "source", targetId: s1.id })).job;
    await claimJob(ws.workspaceId, j1.id, "test-worker");
    await failJob(ws.workspaceId, j1.id, "fetch impossible : 404");
    const f1 = await getSource(ws.workspaceId, s1.id);
    expect(f1?.status).toBe("failed");
    expect((f1?.extractedMeta as Record<string, unknown>).error).toBe("fetch impossible : 404");

    const s2 = await addSource(ws.workspaceId, { ideaId: idea.id, kind: "url", ref: "https://a.test/y" });
    const j2 = (await createJob(ws.workspaceId, { kind: "extract", targetType: "source", targetId: s2.id })).job;
    await cancelJob(ws.workspaceId, j2.id);
    expect((await getSource(ws.workspaceId, s2.id))?.status).toBe("failed");
  });
});
