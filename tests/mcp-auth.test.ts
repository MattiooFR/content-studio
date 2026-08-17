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

  // Les deux 401 doivent se distinguer : « pas de token » et « token invalide »
  // sont deux erreurs de branchement différentes côté client, et le même
  // message pour les deux fait perdre du temps à qui débogue son Bearer.
  it("sans token → le message dit qu'aucune autorisation n'a été fournie", async () => {
    const res = await POST(mcpRequest());
    const corps = await res.json();
    expect(corps.error_description).toMatch(/no authorization/i);
  });

  it("token bidon → le message dit que le token est invalide, pas qu'il est absent", async () => {
    const res = await POST(mcpRequest({ authorization: "Bearer cs_deadbeef" }));
    const corps = await res.json();
    expect(corps.error_description).not.toMatch(/no authorization/i);
    expect(corps.error_description).toMatch(/invalid/i);
  });
});
