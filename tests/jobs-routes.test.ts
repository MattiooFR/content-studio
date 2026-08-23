import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { POST as createRoute, GET as listRoute } from "@/app/api/jobs/route";
import { POST as retryRoute } from "@/app/api/jobs/[id]/retry/route";
import { POST as cancelRoute } from "@/app/api/jobs/[id]/cancel/route";
import { createIdea, getIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate, getContent } from "@/lib/contents";
import { claimJob, failJob } from "@/lib/jobs";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("routes /api/jobs", () => {
  it("POST/GET sans session → 401", async () => {
    expect((await createRoute(req("/api/jobs", jsonInit({ kind: "write" })))).status).toBe(401);
    expect((await listRoute(req("/api/jobs?target_type=idea&target_id=x"))).status).toBe(401);
  });

  it("POST write sur une idée : 201, job queued, idée in_progress ; second POST → 200 + created:false", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "À rédiger" });
    const r1 = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r1.status).toBe(201);
    const { job, created } = await r1.json();
    expect(created).toBe(true);
    expect(job.status).toBe("queued");
    expect(job.requestedBy).toBe(`user:${ws.userId}`);
    expect((await getIdea(ws.workspaceId, idea.id))!.status).toBe("in_progress");

    const r2 = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r2.status).toBe(200);
    expect((await r2.json()).created).toBe(false);
  });

  it("POST write sans channel_key → 400 ; cible d'un autre workspace → 404", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const r = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id })));
    expect(r.status).toBe(400);
    const b = await signUpTestUser();
    const r404 = await createRoute(await authedReq(b, "/api/jobs", jsonInit({
      kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" },
    })));
    expect(r404.status).toBe(404);
  });

  it("POST publish : corps vide → 400 ; corps non vide → contenu approved", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const vide = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "publish", target_type: "content", target_id: contentId })));
    expect(vide.status).toBe(400);
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# Titre\n\nCorps.", authorType: "user" });
    const ok = await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "publish", target_type: "content", target_id: contentId })));
    expect(ok.status).toBe(201);
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("approved");
  });

  it("GET par cible rend les jobs, plus récents d'abord", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })));
    await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "autre", target_type: "idea", target_id: idea.id })));
    const r = await listRoute(await authedReq(ws, `/api/jobs?target_type=idea&target_id=${idea.id}`));
    expect(r.status).toBe(200);
    const jobs = await r.json();
    expect(jobs.map((j: { kind: string }) => j.kind)).toEqual(["autre", "write"]);
  });

  it("retry : failed → queued (200) ; queued → 409 ; autre workspace → 404", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { job } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    expect((await retryRoute(await authedReq(ws, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id))).status).toBe(409);
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const ok = await retryRoute(await authedReq(ws, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("queued");
    const b = await signUpTestUser();
    expect((await retryRoute(await authedReq(b, `/api/jobs/${job.id}/retry`, { method: "POST" }), params(job.id))).status).toBe(404);
  });

  it("cancel : queued → cancelled (200) ; running → 409", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "x" });
    const { job } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    const ok = await cancelRoute(await authedReq(ws, `/api/jobs/${job.id}/cancel`, { method: "POST" }), params(job.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("cancelled");
    const { job: j2 } = await (await createRoute(await authedReq(ws, "/api/jobs", jsonInit({ kind: "write", target_type: "idea", target_id: idea.id, payload: { channel_key: "community" } })))).json();
    await claimJob(ws.workspaceId, j2.id, "w");
    expect((await cancelRoute(await authedReq(ws, `/api/jobs/${j2.id}/cancel`, { method: "POST" }), params(j2.id))).status).toBe(409);
  });
});
