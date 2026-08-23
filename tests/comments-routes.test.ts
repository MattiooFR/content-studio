import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { GET as listRoute, POST as createRoute } from "@/app/api/contents/[id]/comments/route";
import { PATCH as patchRoute, DELETE as deleteRoute } from "@/app/api/contents/[id]/comments/[cid]/route";
import { POST as audioRoute } from "@/app/api/contents/[id]/comments/audio/route";
import { GET as jobAudioRoute } from "@/app/api/jobs/[id]/audio/route";
import { completeJob, claimJob } from "@/lib/jobs";

const P = (id: string, cid?: string) => ({ params: Promise.resolve(cid ? { id, cid } : { id }) }) as never;
const jsonInit = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function contentIn(ws: { workspaceId: string }) {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage.", authorType: "user" });
  return contentId;
}

describe("routes commentaires", () => {
  it("401 sans session sur GET/POST/PATCH/DELETE/audio", async () => {
    const id = crypto.randomUUID();
    expect((await listRoute(req(`/api/contents/${id}/comments`), P(id))).status).toBe(401);
    expect((await createRoute(req(`/api/contents/${id}/comments`, jsonInit({ body: "x" })), P(id))).status).toBe(401);
    expect((await patchRoute(req(`/api/contents/${id}/comments/${id}`, jsonInit({ body: "x" }, "PATCH")), P(id, id))).status).toBe(401);
    expect((await deleteRoute(req(`/api/contents/${id}/comments/${id}`, { method: "DELETE" }), P(id, id))).status).toBe(401);
    expect((await audioRoute(req(`/api/contents/${id}/comments/audio`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "x" }), P(id))).status).toBe(401);
  });

  it("POST crée (201) avec ancrage ; GET liste ; PATCH statut ; DELETE ; 404 hors workspace", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const c = await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: "à revoir", quote: "passage", prefix: "Un ", suffix: "." })), P(contentId));
    expect(c.status).toBe(201);
    const created = await c.json();
    expect(created.quote).toBe("passage");
    const l = await (await listRoute(await authedReq(ws, `/api/contents/${contentId}/comments`), P(contentId))).json();
    expect(l).toHaveLength(1);
    const up = await patchRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${created.id}`, jsonInit({ status: "resolved" }, "PATCH")), P(contentId, created.id));
    expect((await up.json()).status).toBe("resolved");
    const b = await signUpTestUser();
    expect((await listRoute(await authedReq(b, `/api/contents/${contentId}/comments`), P(contentId))).status).toBe(404);
    expect((await patchRoute(await authedReq(b, `/api/contents/${contentId}/comments/${created.id}`, jsonInit({ status: "open" }, "PATCH")), P(contentId, created.id))).status).toBe(404);
    expect((await deleteRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${created.id}`, { method: "DELETE" }), P(contentId, created.id))).status).toBe(200);
  });

  it("POST body vide → 400 ; statut inconnu en PATCH → 400", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    expect((await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: " " })), P(contentId))).status).toBe(400);
    const c = await (await createRoute(await authedReq(ws, `/api/contents/${contentId}/comments`, jsonInit({ body: "ok" })), P(contentId))).json();
    expect((await patchRoute(await authedReq(ws, `/api/contents/${contentId}/comments/${c.id}`, jsonInit({ status: "bizarre" }, "PATCH")), P(contentId, c.id))).status).toBe(400);
  });

  it("audio : 201 {comment, job} ; 415 mime inconnu ; 413 trop gros", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const ok = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio?quote=passage&prefix=Un%20&suffix=.`, {
      method: "POST", headers: { "content-type": "audio/webm;codecs=opus" }, body: new Uint8Array([1, 2, 3]),
    }), P(contentId));
    expect(ok.status).toBe(201);
    const { comment, job } = await ok.json();
    expect(comment.kind).toBe("voice");
    expect(comment.quote).toBe("passage");
    expect(job.kind).toBe("transcribe");
    const bad = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" }), P(contentId));
    expect(bad.status).toBe(415);
    const big = await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(16 * 1024 * 1024 + 1) }), P(contentId));
    expect(big.status).toBe(413);
  });

  it("GET /api/jobs/:id/audio : 401 sans token ; 200 binaire avec le bon token ; 404 autre workspace ; 404 après transcription (audio purgé)", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const { job } = await (await audioRoute(await authedReq(ws, `/api/contents/${contentId}/comments/audio`, {
      method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([9, 8, 7]),
    }), P(contentId))).json();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`), P(job.id))).status).toBe(401);
    const r = await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), P(job.id));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/webm");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${tb}` } }), P(job.id))).status).toBe(404);
    await claimJob(ws.workspaceId, job.id, "w");
    await completeJob(ws.workspaceId, job.id, { text: "ok" });
    expect((await jobAudioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), P(job.id))).status).toBe(404);
  });
});
