import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { generateMcpToken, resolveMcpToken } from "@/lib/tenant";
import {
  createContentDraft, applyContentUpdate, setContentStatus, getContent,
} from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";

describe("e2e : idée → draft (MCP) → update → SSE → published", () => {
  it("le flux complet du critère de fin v1", async () => {
    // 1. un humain crée l'idée
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, {
      title: "Tuto multi-comptes Claude/Codex",
      notes: "Le récit du 05/08 : pool, 429, refresh_token",
    });

    // 2. l'agent s'authentifie par token MCP
    const { token } = await generateMcpToken(ws.workspaceId, "claude-e2e");
    const resolved = await resolveMcpToken(`Bearer ${token}`);
    expect(resolved?.workspaceId).toBe(ws.workspaceId);

    // 3. l'agent crée le draft et écrit — le SSE doit porter l'événement
    const received: WorkspaceEvent[] = [];
    const un = bus.subscribe(ws.workspaceId, (e) => received.push(e));
    const { contentId } = await createContentDraft({
      workspaceId: resolved!.workspaceId, ideaId: idea.id, channelKey: "community",
    });
    const upd = await applyContentUpdate({
      workspaceId: resolved!.workspaceId, contentId,
      body: "# Utilise tes abonnements en code\n\nCe matin, mon compte…",
      authorType: "agent", authorLabel: "claude-e2e",
    });
    expect(upd.state).toBe("current");
    expect(received.some(
      (e) => e.type === "content.updated" && e.contentId === contentId
    )).toBe(true);
    un();

    // 4. l'humain publie
    await setContentStatus(ws.workspaceId, contentId, "published");
    const final = await getContent(ws.workspaceId, contentId);
    expect(final?.status).toBe("published");
    expect(final?.body).toContain("abonnements");
  });
});
