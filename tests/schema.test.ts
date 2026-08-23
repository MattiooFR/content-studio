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
});
