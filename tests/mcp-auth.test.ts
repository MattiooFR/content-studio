import { describe, it, expect } from "vitest";
import { POST } from "@/app/api/[transport]/route";
import { NextRequest } from "next/server";

function mcpRequest(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3003/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
    }),
  });
}

describe("MCP — auth", () => {
  it("sans token → 401", async () => {
    const res = await POST(mcpRequest());
    expect(res.status).toBe(401);
  });

  it("token bidon → 401", async () => {
    const res = await POST(mcpRequest({ authorization: "Bearer cs_deadbeef" }));
    expect(res.status).toBe(401);
  });
});
