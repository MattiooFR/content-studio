import { describe, it, expect } from "vitest";
import { signUpTestUser, authedReq, req } from "./helpers";
import { POST as addRoute } from "@/app/api/ideas/[id]/sources/route";
import { POST as retryRoute } from "@/app/api/sources/[id]/retry/route";
import { createIdea } from "@/lib/ideas";
import { addSource, getSource } from "@/lib/sources";
import { claimJob, failJob, listJobs } from "@/lib/jobs";

const jsonInit = (body: unknown) => ({
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("POST /api/ideas/[id]/sources — v1.1", () => {
  it("text long (au-delà de l'ancienne borne ref) → extracted d'emblée, ref = étiquette", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const long = "Titre du collage\n" + "corps ".repeat(3000); // ~18 000 caractères
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`, jsonInit({ kind: "text", text: long })),
      params(idea.id)
    );
    expect(r.status).toBe(200);
    const source = await r.json();
    expect(source.status).toBe("extracted");
    expect(source.ref).toBe("Titre du collage");
  });

  it("URL YouTube → source video pending + job extract", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`,
        jsonInit({ kind: "url", ref: "https://youtu.be/dQw4w9WgXcQ" })),
      params(idea.id)
    );
    expect(r.status).toBe(200);
    const source = await r.json();
    expect(source.kind).toBe("video");
    expect(
      (await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id }))
    ).toHaveLength(1);
  });

  it("ni ref ni text → 400", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const r = await addRoute(
      await authedReq(ws, `/api/ideas/${idea.id}/sources`, jsonInit({ kind: "url" })),
      params(idea.id)
    );
    expect(r.status).toBe(400);
  });
});

describe("POST /api/sources/[id]/retry", () => {
  it("failed → 200 pending ; non failed → 409 ; autre workspace → 404 ; sans session → 401", async () => {
    const ws = await signUpTestUser();
    const autre = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });
    const source = await addSource(ws.workspaceId, {
      ideaId: idea.id, kind: "url", ref: "https://exemple.fr/retry",
    });
    const [job] = await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: source.id });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "boom");

    expect((await retryRoute(req(`/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id))).status).toBe(401);
    expect((await retryRoute(await authedReq(autre, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id))).status).toBe(404);

    const ok = await retryRoute(await authedReq(ws, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id));
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("pending");
    expect((await getSource(ws.workspaceId, source.id))?.status).toBe("pending");

    const again = await retryRoute(await authedReq(ws, `/api/sources/${source.id}/retry`, { method: "POST" }), params(source.id));
    expect(again.status).toBe(409);
  });
});
