import { describe, it, expect } from "vitest";
import { generateMcpToken } from "@/lib/tenant";
import { createIdea } from "@/lib/ideas";
import { addSource } from "@/lib/sources";
import { listJobs } from "@/lib/jobs";
import { signUpTestUser, callMcpTool } from "./helpers";

describe("MCP — sources v1.1", () => {
  it("add_source : URL YouTube reclassée video + job extract ; text long extrait d'emblée", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "test");
    const idea = await createIdea(ws.workspaceId, { title: "Idée" });

    const rVideo = await callMcpTool(token, "add_source", {
      idea_id: idea.id, kind: "url", ref: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    expect(rVideo.status).toBe(200);
    const video = JSON.parse(rVideo.texte);
    expect(video.kind).toBe("video");
    expect(
      await listJobs(ws.workspaceId, { kind: "extract", targetType: "source", targetId: video.id })
    ).toHaveLength(1);

    const long = "Notes de veille\n" + "contenu ".repeat(1000);
    const rText = await callMcpTool(token, "add_source", { idea_id: idea.id, kind: "text", text: long });
    expect(rText.status).toBe(200);
    const texte = JSON.parse(rText.texte);
    expect(texte.status).toBe("extracted");
    expect(texte.extractedText).toBe(long);
  });

  it("list_sources filtre par idea_id", async () => {
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "test");
    const ideaA = await createIdea(ws.workspaceId, { title: "A" });
    const ideaB = await createIdea(ws.workspaceId, { title: "B" });
    const sA = await addSource(ws.workspaceId, { ideaId: ideaA.id, kind: "text", text: "notes A" });
    await addSource(ws.workspaceId, { ideaId: ideaB.id, kind: "text", text: "notes B" });

    const r = await callMcpTool(token, "list_sources", { idea_id: ideaA.id });
    expect(r.status).toBe(200);
    const rows = JSON.parse(r.texte);
    expect(rows.map((s: { id: string }) => s.id)).toEqual([sA.id]);
  });
});
