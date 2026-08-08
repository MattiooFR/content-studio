import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST, OPTIONS } from "@/app/api/clip/route";
import { signUpTestUser } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { getIdea } from "@/lib/ideas";
import { getSource } from "@/lib/sources";
import {
  MAX_SOURCE_EXCERPT_LENGTH, MAX_SOURCE_REF_LENGTH, MAX_SOURCE_TITLE_LENGTH,
} from "@/lib/sources";

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

// Corps BRUT (pas de JSON.stringify) : seule façon de reproduire un req.json()
// qui throw, ou un JSON valide mais pas un objet à plat (durcissement 4).
function rawClipRequest(rawBody: string, authToken?: string) {
  return new NextRequest("http://localhost:3003/api/clip", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authToken && { authorization: `Bearer ${authToken}` }),
    },
    body: rawBody,
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

  // Durcissement 4 (revue finale, vague cockpit) : req.json() throw sur un
  // corps non-JSON, et la destructuration qui suivait throw sur `null` —
  // les deux remontaient en 500 générique. Toujours 400 { error: "corps
  // invalide" } désormais, jamais un 500.
  describe("corps invalide (durcissement)", () => {
    it("corps non-JSON (chaîne brute cassée) → 400 'corps invalide', jamais 500", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(rawClipRequest("ceci n'est pas du JSON {{{", token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("corps invalide");
    });

    it("corps vide → 400 'corps invalide'", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(rawClipRequest("", token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("corps invalide");
    });

    it.each([
      ["null", "null"],
      ["tableau", "[1,2,3]"],
      ["chaîne", '"juste une chaîne"'],
      ["nombre", "42"],
    ])("JSON valide mais pas un objet à plat (%s) → 400 'corps invalide'", async (_label, rawBody) => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(rawClipRequest(rawBody, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("corps invalide");
    });
  });

  // Durcissement 6 (revue finale, vague cockpit) : mêmes bornes qu'addSource
  // (src/lib/sources.ts), réutilisées ici via les MÊMES constantes exportées
  // — une valeur hors bornes est une entrée CASSÉE (400), jamais tronquée.
  describe("bornes anti-DoS (durcissement)", () => {
    it("URL au-delà de MAX_SOURCE_REF_LENGTH → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const tooLongUrl = `https://example.com/${"x".repeat(MAX_SOURCE_REF_LENGTH)}`;
      const res = await POST(clipRequest({ url: tooLongUrl }, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/URL trop longue/);
    });

    it("title au-delà de MAX_SOURCE_TITLE_LENGTH → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({
        url: "https://example.com/page",
        title: "x".repeat(MAX_SOURCE_TITLE_LENGTH + 1),
      }, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/title trop long/);
    });

    it("selection au-delà de MAX_SOURCE_EXCERPT_LENGTH → 400", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({
        url: "https://example.com/page",
        selection: "x".repeat(MAX_SOURCE_EXCERPT_LENGTH + 1),
      }, token));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/selection trop longue/);
    });

    it("title/selection exactement à la borne → 200, acceptés", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");
      const res = await POST(clipRequest({
        url: "https://example.com/page",
        title: "x".repeat(MAX_SOURCE_TITLE_LENGTH),
        selection: "x".repeat(MAX_SOURCE_EXCERPT_LENGTH),
      }, token));
      expect(res.status).toBe(200);
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

  // CORS (W5) : l'extension Chrome demande une optional_host_permission au
  // moment de la config (bypass CORS natif, pas de header nécessaire), mais
  // ce handler sert de filet de secours. Restreint à chrome-extension://.
  describe("CORS extension", () => {
    it("OPTIONS depuis chrome-extension:// → 204 + headers reflétant l'origine", async () => {
      const req = new NextRequest("http://localhost:3003/api/clip", {
        method: "OPTIONS",
        headers: { origin: "chrome-extension://abcdefabcdefabcdefabcdefabcdefab" },
      });
      const res = await OPTIONS(req);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://abcdefabcdefabcdefabcdefabcdefab"
      );
      expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    });

    it("OPTIONS depuis une origine web classique → pas de header CORS (pas d'ouverture large)", async () => {
      const req = new NextRequest("http://localhost:3003/api/clip", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      });
      const res = await OPTIONS(req);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    });

    it("POST depuis chrome-extension:// → réponse porte Access-Control-Allow-Origin", async () => {
      const ws = await signUpTestUser();
      const { token } = await generateMcpToken(ws.workspaceId, "test-clipper");

      const req = new NextRequest("http://localhost:3003/api/clip", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: "chrome-extension://abcdefabcdefabcdefabcdefabcdefab",
        },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(
        "chrome-extension://abcdefabcdefabcdefabcdefabcdefab"
      );
    });
  });
});
