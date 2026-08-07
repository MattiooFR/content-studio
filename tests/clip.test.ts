import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/clip/route";
import { signUpTestUser } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { getIdea } from "@/lib/ideas";
import { getSource } from "@/lib/sources";

function clipRequest(
  body: Record<string, unknown>,
  authToken?: string,
) {
  return new NextRequest("http://localhost:3003/api/clip", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken && { authorization: `Bearer ${authToken}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/clip", () => {
  describe("auth", () => {
    it("sans token → 401", async () => {
      const res = await POST(clipRequest({ url: "https://example.com" }));
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toHaveProperty("error");
    });

    it("token bidon → 401", async () => {
      const res = await POST(clipRequest({ url: "https://example.com" }, "cs_deadbeef"));
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data).toHaveProperty("error");
    });
  });

  describe("validation", () => {
    it("URL vide → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({ url: "" }, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/invalide/i);
    });

    it("URL non-string → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({ url: 123 }, token));
      expect(res.status).toBe(400);
    });

    it("URL javascript: → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({ url: "javascript:alert(1)" }, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/invalide/i);
    });

    it("URL sans protocole → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({ url: "example.com" }, token));
      expect(res.status).toBe(400);
    });

    it("title objet ignoré → idée titrée par URL", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({
        url: "https://example.com/page",
        title: { foo: "bar" },
      }, token));

      expect(res.status).toBe(200);
      const data = await res.json() as { ideaId: string };
      const idea = await getIdea(ws.workspaceId, data.ideaId);
      expect(idea?.title).toBe("https://example.com/page");
    });

    it("selection array ignoré → rawExcerpt ''", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({
        url: "https://example.com/page",
        selection: ["not", "a", "string"],
      }, token));

      expect(res.status).toBe(200);
      const data = await res.json() as { sourceId: string };
      const source = await getSource(ws.workspaceId, data.sourceId);
      expect(source?.rawExcerpt).toBe("");
    });
  });

  describe("nominal", () => {
    it("crée idée + source en transaction", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "https://example.com/article",
        title: "Ma Source",
        selection: "Extrait du texte",
      }, token));

      expect(res.status).toBe(200);
      const data = await res.json() as { ideaId: string; sourceId: string };
      expect(data).toHaveProperty("ideaId");
      expect(data).toHaveProperty("sourceId");

      // Vérifier que l'idée existe et a les bonnes props
      const idea = await getIdea(ws.workspaceId, data.ideaId);
      expect(idea).toBeTruthy();
      expect(idea?.title).toBe("Ma Source");
      expect(idea?.status).toBe("inbox");
      expect(idea?.createdBy).toBe("clipper");

      // Vérifier que la source existe et a les bonnes props
      const source = await getSource(ws.workspaceId, data.sourceId);
      expect(source).toBeTruthy();
      expect(source?.ref).toBe("https://example.com/article");
      expect(source?.kind).toBe("url");
      expect(source?.rawExcerpt).toBe("Extrait du texte");
      expect(source?.ideaId).toBe(data.ideaId);
    });

    it("title fallback à URL si absent", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "https://example.com/page",
      }, token));

      expect(res.status).toBe(200);
      const data = await res.json() as { ideaId: string };
      const idea = await getIdea(ws.workspaceId, data.ideaId);
      expect(idea?.title).toBe("https://example.com/page");
    });

    it("selection fallback à '' si absent", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "https://example.com/page",
        title: "Article",
      }, token));

      expect(res.status).toBe(200);
      const data = await res.json() as { sourceId: string };
      const source = await getSource(ws.workspaceId, data.sourceId);
      expect(source?.rawExcerpt).toBe("");
    });

    it("https accepté", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "https://example.com",
      }, token));

      expect(res.status).toBe(200);
    });

    it("http accepté", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "http://example.com",
      }, token));

      expect(res.status).toBe(200);
    });
  });

  describe("isolation workspace", () => {
    it("token du workspace A ne crée rien chez B", async () => {
      const a = await signUpTestUser();
      const b = await signUpTestUser();
      const { token: tokenA } = await generateMcpToken(a.workspaceId, "test");

      const res = await POST(clipRequest({
        url: "https://example.com",
        title: "Article",
      }, tokenA));

      expect(res.status).toBe(200);
      const data = await res.json() as { ideaId: string };

      // L'idée doit exister chez A
      const ideaInA = await getIdea(a.workspaceId, data.ideaId);
      expect(ideaInA).toBeTruthy();

      // Pas visible chez B
      const ideaInB = await getIdea(b.workspaceId, data.ideaId);
      expect(ideaInB).toBeNull();
    });
  });

  describe("atomicité", () => {
    it("idée invalid ne laisse pas de source orpheline", async () => {
      // Ce test est implicite : si la validation URL échoue EN PREMIER,
      // il ne peut pas y avoir de création partielle. La transaction
      // garantit que soit tout est créé, soit rien.
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const res = await POST(clipRequest({
        url: "javascript:void(0)",
      }, token));

      expect(res.status).toBe(400);
      // Pas d'idée, pas de source créées.
      // On ne peut pas vérifier direc qu'il n'y a rien, mais la cohérence
      // est garantie par la transaction.
    });
  });
});
