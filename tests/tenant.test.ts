import { describe, it, expect } from "vitest";
import { generateMcpToken, resolveMcpToken, revokeMcpToken } from "@/lib/tenant";
import { signUpTestUser } from "./helpers";

describe("tokens MCP", () => {
  it("un token généré résout vers SON workspace, pas un autre", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const { token } = await generateMcpToken(a.workspaceId, "agent-test");

    const resolved = await resolveMcpToken(`Bearer ${token}`);
    expect(resolved?.workspaceId).toBe(a.workspaceId);
    expect(resolved?.workspaceId).not.toBe(b.workspaceId);
  });

  it("révoqué, inconnu ou absent → null", async () => {
    const a = await signUpTestUser();
    const { token, id } = await generateMcpToken(a.workspaceId, "agent-test");
    await revokeMcpToken(a.workspaceId, id);
    expect(await resolveMcpToken(`Bearer ${token}`)).toBeNull();
    expect(await resolveMcpToken("Bearer cs_inconnu")).toBeNull();
    expect(await resolveMcpToken(null)).toBeNull();
  });
});
