import { describe, it, expect } from "vitest";
import { tableNames } from "./helpers";

describe("schéma", () => {
  it("toutes les tables du domaine existent", async () => {
    const names = await tableNames();
    for (const t of [
      "user", "session", "account", "verification",
      "workspaces", "memberships", "mcp_tokens",
      "ideas", "channels", "personas", "art_directions",
      "contents", "content_revisions", "assets",
    ]) {
      expect(names, `table manquante: ${t}`).toContain(t);
    }
  });

  it("la table agent_jobs existe (Task 1, vague cockpit agent)", async () => {
    const names = await tableNames();
    expect(names).toContain("agent_jobs");
  });

  it("la table publications existe", async () => {
    const names = await tableNames();
    expect(names).toContain("publications");
  });

  it("les tables content_comments et comment_audio existent (Task 10)", async () => {
    const names = await tableNames();
    expect(names).toContain("content_comments");
    expect(names).toContain("comment_audio");
  });

  it("les tables watch_items, watch_feeds et watch_settings existent (Task 1, veille)", async () => {
    const names = await tableNames();
    expect(names).toContain("watch_items");
    expect(names).toContain("watch_feeds");
    expect(names).toContain("watch_settings");
  });
});
