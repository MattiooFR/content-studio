import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { POST as createRoute, GET as listRoute } from "@/app/api/dictations/route";
import { GET as getRoute, DELETE as deleteRoute } from "@/app/api/dictations/[id]/route";
import { POST as retryRoute } from "@/app/api/dictations/[id]/retry/route";
import { POST as consumeRoute } from "@/app/api/dictations/[id]/consume/route";
import { GET as audioRoute } from "@/app/api/jobs/[id]/audio/route";
import { createDictation, applyDictation, getDictation } from "@/lib/dictations";
import { claimJob, failJob, listJobs } from "@/lib/jobs";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
// Uint8Array<ArrayBuffer> (et pas le bare "Uint8Array", générique ArrayBufferLike
// depuis TS 5.7) : sinon tsc refuse `body` contre BodyInit (DOM veut ArrayBuffer).
const audioInit = (bytes: Uint8Array<ArrayBuffer>, mime = "audio/webm") => ({ method: "POST", headers: { "content-type": mime }, body: bytes });

describe("POST /api/dictations", () => {
  it("201 avec field_key, job transcribe créé ; 401 sans session ; 415 mime ; 400 vide ; 413 trop gros", async () => {
    const ws = await signUpTestUser();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect((await createRoute(req("/api/dictations", audioInit(bytes)))).status).toBe(401);

    const r = await createRoute(await authedReq(ws, "/api/dictations?field_key=idea%3A1%3Anotes", audioInit(bytes)));
    expect(r.status).toBe(201);
    const { id, status, fieldKey } = await r.json();
    expect(status).toBe("pending");
    expect(fieldKey).toBe("idea:1:notes");
    expect(await listJobs(ws.workspaceId, { kind: "transcribe", targetType: "dictation", targetId: id })).toHaveLength(1);

    expect((await createRoute(await authedReq(ws, "/api/dictations", audioInit(bytes, "text/plain")))).status).toBe(415);
    expect((await createRoute(await authedReq(ws, "/api/dictations", audioInit(new Uint8Array(0))))).status).toBe(400);
    const big = await authedReq(ws, "/api/dictations", { method: "POST", headers: { "content-type": "audio/webm", "content-length": String(16 * 1024 * 1024 + 1) }, body: bytes });
    expect((await createRoute(big)).status).toBe(413);
  });
});

describe("GET/DELETE /api/dictations, retry, consume", () => {
  it("liste (sans audio), open par field_key, get, consume, retry, delete, cloisonnement", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const { dictation, job } = await createDictation(ws.workspaceId, { audio: Buffer.from("abc"), mime: "audio/webm", fieldKey: "k" });
    const { dictation: ready } = await createDictation(ws.workspaceId, { audio: Buffer.from("abc"), mime: "audio/webm", fieldKey: "k" });
    await applyDictation(ws.workspaceId, ready.id, "texte prêt");

    const list = await listRoute(await authedReq(ws, "/api/dictations"));
    expect(list.status).toBe(200);
    const rows = await list.json();
    expect(rows.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([dictation.id, ready.id]));
    expect("bytes" in rows[0]).toBe(false);

    const open = await (await listRoute(await authedReq(ws, "/api/dictations?field_key=k&open=1"))).json();
    expect(open.map((d: { id: string }) => d.id).sort()).toEqual([dictation.id, ready.id].sort());

    expect((await getRoute(await authedReq(ws, `/api/dictations/${ready.id}`), params(ready.id))).status).toBe(200);
    expect((await getRoute(await authedReq(autre, `/api/dictations/${ready.id}`), params(ready.id))).status).toBe(404);

    const consumed = await consumeRoute(await authedReq(ws, `/api/dictations/${ready.id}/consume`, { method: "POST" }), params(ready.id));
    expect(consumed.status).toBe(200);
    const consumedBody = await consumed.json();
    expect(consumedBody.consumedAt).not.toBeNull();
    expect(consumedBody.first).toBe(true);
    expect((await (await listRoute(await authedReq(ws, "/api/dictations?field_key=k&open=1"))).json()).map((d: { id: string }) => d.id)).toEqual([dictation.id]);

    // ?limit=abc invalide : Number(...) → NaN → ne doit jamais atteindre .limit(NaN) (500 Postgres) — replie sur le défaut (M1)
    expect((await listRoute(await authedReq(ws, "/api/dictations?limit=abc"))).status).toBe(200);

    expect((await retryRoute(await authedReq(ws, `/api/dictations/${dictation.id}/retry`, { method: "POST" }), params(dictation.id))).status).toBe(409);
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");
    const retried = await retryRoute(await authedReq(ws, `/api/dictations/${dictation.id}/retry`, { method: "POST" }), params(dictation.id));
    expect(retried.status).toBe(200);
    expect((await retried.json()).status).toBe("pending");

    expect((await deleteRoute(await authedReq(autre, `/api/dictations/${dictation.id}`), params(dictation.id))).status).toBe(404);
    expect((await deleteRoute(await authedReq(ws, `/api/dictations/${dictation.id}`), params(dictation.id))).status).toBe(204);
    expect(await getDictation(ws.workspaceId, dictation.id)).toBeNull();
  });
});

describe("GET /api/jobs/[id]/audio — dictée", () => {
  it("sert l'audio d'un job transcribe/dictation du workspace du token ; 404 sinon", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const { token: tokenAutre } = await generateMcpToken(autre.workspaceId, "w");
    const { job } = await createDictation(ws.workspaceId, { audio: Buffer.from("opus!"), mime: "audio/webm", fieldKey: "a" });

    const ok = await audioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${token}` } }), params(job.id));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("audio/webm");
    expect(Buffer.from(await ok.arrayBuffer()).toString()).toBe("opus!");

    expect((await audioRoute(req(`/api/jobs/${job.id}/audio`, { headers: { authorization: `Bearer ${tokenAutre}` } }), params(job.id))).status).toBe(404);
    expect((await audioRoute(req(`/api/jobs/${job.id}/audio`), params(job.id))).status).toBe(401);
  });
});
