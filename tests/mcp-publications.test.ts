import { describe, it, expect } from "vitest";
import { signUpTestUser, callMcpTool } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { listPublications, bodyHash } from "@/lib/publications";

describe("MCP — publications", () => {
  it("link_publication crée/upsert, list_publications filtre, mark_synced met à jour ; cloisonnés", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "w");
    const idea = await createIdea(ws.workspaceId, { title: "I" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv1", authorType: "user" });

    const linked = JSON.parse((await callMcpTool(token, "link_publication", {
      content_id: contentId, target: "fluentcommunity", external_id: "77",
      url: "https://c.test/post/77", meta: { space: "actus-ia" }, body_hash: bodyHash("# T\n\nv1"),
    })).texte);
    expect(linked.externalId).toBe("77");
    const list = JSON.parse((await callMcpTool(token, "list_publications", { target: "fluentcommunity" })).texte);
    expect(list).toHaveLength(1);
    expect(list[0].contentId).toBe(contentId);
    const synced = JSON.parse((await callMcpTool(token, "mark_synced", { publication_id: linked.id, body_hash: "h2" })).texte);
    expect(synced.publishedBodyHash).toBe("h2");

    const b = await signUpTestUser();
    const { token: tb } = await generateMcpToken(b.workspaceId, "b");
    expect(JSON.parse((await callMcpTool(tb, "list_publications", {})).texte)).toHaveLength(0);
    expect(JSON.parse((await callMcpTool(tb, "mark_synced", { publication_id: linked.id, body_hash: "x" })).texte).error).toMatch(/introuvable/);
    expect(JSON.parse((await callMcpTool(tb, "link_publication", { content_id: contentId, target: "t", external_id: "1", body_hash: "h" })).texte).error).toMatch(/introuvable/);
    expect((await listPublications(ws.workspaceId, { contentId }))[0].publishedBodyHash).toBe("h2");
  });
});
