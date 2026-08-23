import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { createComment, getComment } from "@/lib/comments";

describe("MCP — commentaires", () => {
  it("list_comments rend les commentaires avec ancrage résolu ; resolve_comment change le statut ; cloisonnés", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const idea = await createIdea(ws.workspaceId, { title: "I" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage à raccourcir ici.", authorType: "user" });
    const c = await createComment(ws.workspaceId, { contentId, body: "raccourcis", quote: "passage à raccourcir", prefix: "Un ", suffix: " ici" });
    const orphan = await createComment(ws.workspaceId, { contentId, body: "général" });
    const r = JSON.parse((await callMcpTool(token, "list_comments", { content_id: contentId, status: "open" })).texte);
    expect(r).toHaveLength(2);
    const a = r.find((x: { id: string }) => x.id === c.id);
    expect(a.anchor_found).toBe(true);
    expect(a.position.level).toBe(1);
    expect(r.find((x: { id: string }) => x.id === orphan.id).anchor_found).toBe(false);
    const res = JSON.parse((await callMcpTool(token, "resolve_comment", { comment_id: c.id, status: "applied" })).texte);
    expect(res.status).toBe("applied");
    expect((await getComment(ws.workspaceId, c.id))!.status).toBe("applied");
    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect(JSON.parse((await callMcpTool(tb, "list_comments", { content_id: contentId })).texte).error).toMatch(/introuvable/);
    expect(JSON.parse((await callMcpTool(tb, "resolve_comment", { comment_id: c.id, status: "open" })).texte).error).toMatch(/introuvable/);
  });
});
