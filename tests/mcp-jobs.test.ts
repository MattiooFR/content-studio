import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea, getIdea } from "@/lib/ideas";
import { createContentDraft, getContent } from "@/lib/contents";
import { createJob, getJob } from "@/lib/jobs";

async function setup() {
  const ws = await signUpTestUser();
  const { token } = await generateMcpToken(ws.workspaceId, "worker-test");
  const idea = await createIdea(ws.workspaceId, { title: "Idée MCP" });
  return { ws, token, idea };
}

describe("MCP — jobs", () => {
  it("list_jobs rend les queued du workspace du token, plus anciens d'abord, avec le titre de la cible", async () => {
    const { ws, token, idea } = await setup();
    await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id, payload: { channel_key: "community" } });
    const r = await callMcpTool(token, "list_jobs", { status: "queued" });
    const jobs = JSON.parse(r.texte);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].kind).toBe("write");
    expect(jobs[0].payload).toEqual({ channel_key: "community" });
    expect(jobs[0].targetTitle).toBe("Idée MCP");
  });

  it("claim → heartbeat → complete : transitions visibles ; second claim → error", async () => {
    const { ws, token, idea } = await setup();
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    const c = JSON.parse((await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "mac-mini" })).texte);
    expect(c.status).toBe("running");
    expect(c.claimedBy).toBe("mac-mini");
    const again = JSON.parse((await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "autre" })).texte);
    expect(again.error).toMatch(/déjà pris/);
    const hb = JSON.parse((await callMcpTool(token, "heartbeat_job", { job_id: job.id })).texte);
    expect(hb.status).toBe("running");
    const done = JSON.parse((await callMcpTool(token, "complete_job", { job_id: job.id, result: { content_id: "x" } })).texte);
    expect(done.status).toBe("done");
    expect(done.result).toEqual({ content_id: "x" });
  });

  it("fail_job pose failed + error", async () => {
    const { ws, token, idea } = await setup();
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    await callMcpTool(token, "claim_job", { job_id: job.id, worker_label: "w" });
    const f = JSON.parse((await callMcpTool(token, "fail_job", { job_id: job.id, error: "timeout enquêteur" })).texte);
    expect(f.status).toBe("failed");
    expect(f.error).toBe("timeout enquêteur");
  });

  it("le token de B ne voit ni ne claim les jobs de A", async () => {
    const { ws, idea } = await setup();
    const b = await signUpTestUser();
    const { token: tokenB } = await generateMcpToken(b.workspaceId, "b");
    const { job } = await createJob(ws.workspaceId, { kind: "write", targetType: "idea", targetId: idea.id });
    expect(JSON.parse((await callMcpTool(tokenB, "list_jobs", {})).texte)).toHaveLength(0);
    const r = JSON.parse((await callMcpTool(tokenB, "claim_job", { job_id: job.id, worker_label: "b" })).texte);
    expect(r.error).toMatch(/introuvable/);
    expect((await getJob(ws.workspaceId, job.id))!.status).toBe("queued");
  });

  it("set_content_status et update_idea : cloisonnés, effets réels", async () => {
    const { ws, token, idea } = await setup();
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    const s = JSON.parse((await callMcpTool(token, "set_content_status", { content_id: contentId, status: "review" })).texte);
    expect(s.status).toBe("review");
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("review");
    const u = JSON.parse((await callMcpTool(token, "update_idea", { idea_id: idea.id, status: "done", tags: ["communaute"] })).texte);
    expect(u.status).toBe("done");
    expect((await getIdea(ws.workspaceId, idea.id))!.tags).toEqual(["communaute"]);

    const b = await signUpTestUser();
    const { token: tokenB } = await generateMcpToken(b.workspaceId, "b");
    const sb = JSON.parse((await callMcpTool(tokenB, "set_content_status", { content_id: contentId, status: "published" })).texte);
    expect(sb.error).toMatch(/introuvable/);
    expect((await getContent(ws.workspaceId, contentId))!.status).toBe("review");
    const ub = JSON.parse((await callMcpTool(tokenB, "update_idea", { idea_id: idea.id, status: "archived" })).texte);
    expect(ub.error).toMatch(/introuvable/);
  });
});
