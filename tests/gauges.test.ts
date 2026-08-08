import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gaugeSources } from "@/lib/db/schema";
import {
  createGaugeSource, listGaugeSources, getGaugeSource,
  updateGaugeSource, deleteGaugeSource,
  fetchGaugeSource, refreshGauges, getGaugesState,
  redactHeadersForClient,
} from "@/lib/gauges";
import { signUpTestUser } from "./helpers";

// ---- mini-serveur http éphémère (port haut aléatoire, 127.0.0.1 only) ----
function startServer(handler: http.RequestListener) {
  return new Promise<{ url: string; hits: () => number; close: () => Promise<void> }>((resolve) => {
    let hitCount = 0;
    const server = http.createServer((req, res) => {
      hitCount += 1;
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => hitCount,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function jsonHandler(payload: unknown, status = 200): http.RequestListener {
  return (req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

describe("fetchGaugeSource — contrat de payload", () => {
  it("payload conforme multi-comptes → parsé", async () => {
    const srv = await startServer(jsonHandler({
      accounts: [
        { id: "compte-1", usedPercent: 87, resetAt: "2026-09-01T00:00:00Z", available: true },
        { id: "compte-2", usedPercent: 12, available: false },
      ],
      costMonthlyEur: 378,
    }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect(result).toEqual({
      payload: {
        accounts: [
          { id: "compte-1", usedPercent: 87, resetAt: "2026-09-01T00:00:00Z", available: true },
          { id: "compte-2", usedPercent: 12, available: false },
        ],
        costMonthlyEur: 378,
      },
    });
  });

  it("champs inconnus ignorés", async () => {
    const srv = await startServer(jsonHandler({
      accounts: [{ id: "c1", usedPercent: 50, weirdField: "x" }],
      costMonthlyEur: 10,
      unknownTopLevel: true,
    }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("payload" in result).toBe(true);
    if ("payload" in result) {
      expect(result.payload).toEqual({
        accounts: [{ id: "c1", usedPercent: 50 }],
        costMonthlyEur: 10,
      });
    }
  });

  it("accounts non tableau (malformé) → error sans throw", async () => {
    const srv = await startServer(jsonHandler({ accounts: "nope" }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
    expect("payload" in result).toBe(false);
  });

  it("type faux dans un compte (usedPercent string) → error sans throw", async () => {
    const srv = await startServer(jsonHandler({
      accounts: [{ id: "c1", usedPercent: "beaucoup" }],
    }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });

  it("id manquant dans un compte → error sans throw", async () => {
    const srv = await startServer(jsonHandler({ accounts: [{ usedPercent: 50 }] }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });

  it("HTTP non-2xx → error sans throw", async () => {
    const srv = await startServer(jsonHandler({ error: "boom" }, 500));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });

  it("JSON invalide → error sans throw", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("ceci n'est pas du json");
    });
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });

  it("timeout : handler qui ne répond jamais → error en moins de 5 s", async () => {
    const srv = await startServer(() => {
      // ne répond jamais — le client doit abandonner tout seul.
    });
    const start = Date.now();
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    const elapsed = Date.now() - start;
    await srv.close();

    expect("error" in result).toBe(true);
    expect(elapsed).toBeLessThan(5000);
  });

  it("connexion refusée (port fermé) → error sans throw", async () => {
    // 127.0.0.1:1 : port privilégié quasi certainement fermé, ECONNREFUSED immédiat.
    const result = await fetchGaugeSource({ url: "http://127.0.0.1:1", headers: {} });
    expect("error" in result).toBe(true);
  });

  it("headers custom transmis à la requête", async () => {
    const srv = await startServer((req, res) => {
      if (req.headers["x-api-key"] === "secret-123") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ costMonthlyEur: 42 }));
      } else {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
      }
    });
    const result = await fetchGaugeSource({ url: srv.url, headers: { "x-api-key": "secret-123" } });
    await srv.close();

    expect(result).toEqual({ payload: { costMonthlyEur: 42 } });
  });

  it("redirection (3xx) refusée : jamais suivie, la cible ne reçoit AUCUNE requête", async () => {
    const target = await startServer(jsonHandler({ costMonthlyEur: 999 }));
    const redirector = await startServer((req, res) => {
      res.writeHead(302, { Location: target.url });
      res.end();
    });

    const result = await fetchGaugeSource({
      url: redirector.url,
      headers: { "x-api-key": "secret-123" },
    });
    await Promise.all([redirector.close(), target.close()]);

    expect("error" in result).toBe(true);
    // la cible redirigée n'a JAMAIS reçu la requête — ni le header custom avec elle.
    expect(target.hits()).toBe(0);
  });

  it("réponse > 1 MiB → error sans throw, jamais bufferisée en entier", async () => {
    const srv = await startServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // 2 MiB de padding dans une string JSON valide autrement.
      res.end(JSON.stringify({ costMonthlyEur: 1, padding: "x".repeat(2 * 1024 * 1024) }));
    });
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/grosse/i);
  });

  it("usedPercent hors [0,100] (250) → error, jamais de clamp silencieux", async () => {
    const srv = await startServer(jsonHandler({ accounts: [{ id: "c1", usedPercent: 250 }] }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });

  it("accounts au-delà de 50 entrées → error", async () => {
    const accounts = Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, usedPercent: 1 }));
    const srv = await startServer(jsonHandler({ accounts }));
    const result = await fetchGaugeSource({ url: srv.url, headers: {} });
    await srv.close();

    expect("error" in result).toBe(true);
  });
});

describe("createGaugeSource — validation + SSRF", () => {
  it("URL https valide + headers valides → créée, enabled par défaut", async () => {
    const ws = await signUpTestUser();
    const row = await createGaugeSource(ws.workspaceId, {
      name: "Bridge Claude", url: "https://bridge.example.com/health",
      headers: { "x-api-key": "abc" }, kind: "quota",
    });
    expect(row.enabled).toBe(true);
    expect(row.lastPayload).toEqual({});
    expect(row.lastFetchedAt).toBeNull();
    expect(row.lastError).toBeNull();
    expect(row.headers).toEqual({ "x-api-key": "abc" });
  });

  it("URL sans protocole → rejetée", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "example.com", kind: "quota" })
    ).rejects.toThrow(/URL invalide/);
  });

  it("URL javascript: → rejetée", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "javascript:alert(1)", kind: "quota" })
    ).rejects.toThrow(/URL invalide/);
  });

  it("IP privées littérales (10.*, 192.168.*, 169.254.*, 127.* hors 127.0.0.1) → rejetées", async () => {
    const ws = await signUpTestUser();
    for (const bad of [
      "http://10.0.0.5/health",
      "http://192.168.1.1/health",
      "http://169.254.1.1/health",
      "http://127.0.0.2/health",
    ]) {
      await expect(
        createGaugeSource(ws.workspaceId, { name: "x", url: bad, kind: "quota" })
      ).rejects.toThrow(/IP privée/);
    }
  });

  it("172.16.0.0/12 (RFC1918) refusé sur toute la plage, mais PAS hors plage (172.15.*, 172.32.*)", async () => {
    const ws = await signUpTestUser();
    for (const bad of ["http://172.16.0.5/health", "http://172.31.255.255/health"]) {
      await expect(
        createGaugeSource(ws.workspaceId, { name: "x", url: bad, kind: "quota" })
      ).rejects.toThrow(/IP privée/);
    }
    // contrôle négatif : hors plage, ne doit PAS être bloqué à tort.
    for (const ok of ["http://172.15.0.1/health", "http://172.32.0.1/health"]) {
      await expect(
        createGaugeSource(ws.workspaceId, { name: "x", url: ok, kind: "quota" })
      ).resolves.toBeTruthy();
    }
  });

  it("100.64.0.0/10 (CGNAT) refusé sur toute la plage, mais PAS hors plage (100.63.*, 100.128.*)", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "http://100.64.0.1/health", kind: "quota" })
    ).rejects.toThrow(/IP privée/);
    // contrôle négatif : hors plage, ne doit PAS être bloqué à tort.
    for (const ok of ["http://100.63.255.255/health", "http://100.128.0.1/health"]) {
      await expect(
        createGaugeSource(ws.workspaceId, { name: "x", url: ok, kind: "quota" })
      ).resolves.toBeTruthy();
    }
  });

  it("localhost et 127.0.0.1 explicitement autorisés (self-host)", async () => {
    const ws = await signUpTestUser();
    const a = await createGaugeSource(ws.workspaceId, {
      name: "a", url: "http://127.0.0.1:4000/health", kind: "quota",
    });
    const b = await createGaugeSource(ws.workspaceId, {
      name: "b", url: "http://localhost:4000/health", kind: "quota",
    });
    expect(a.url).toBe("http://127.0.0.1:4000/health");
    expect(b.url).toBe("http://localhost:4000/health");
  });

  it("IPv6 littéral refusé, SAUF [::1] (même logique que 127.0.0.1)", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "http://[::1]/health", kind: "quota" })
    ).resolves.toBeTruthy();
    for (const bad of ["http://[fe80::1]/health", "http://[fc00::1]/health", "http://[::ffff:10.0.0.5]/health"]) {
      await expect(
        createGaugeSource(ws.workspaceId, { name: "x", url: bad, kind: "quota" })
      ).rejects.toThrow(/IP privée/);
    }
  });

  it("0.0.0.0 refusé", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "http://0.0.0.0/health", kind: "quota" })
    ).rejects.toThrow(/IP privée/);
  });

  it("headers avec valeur non-string → rejetés", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, {
        name: "x", url: "https://example.com", kind: "quota",
        headers: { count: 3 } as unknown as Record<string, string>,
      })
    ).rejects.toThrow(/headers/);
  });

  it("name trop long (> 100) → rejeté", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x".repeat(101), url: "https://example.com", kind: "quota" })
    ).rejects.toThrow(/name/);
  });

  it("url trop longue (> 500) → rejetée", async () => {
    const ws = await signUpTestUser();
    const longUrl = `https://example.com/${"a".repeat(500)}`;
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: longUrl, kind: "quota" })
    ).rejects.toThrow(/url/i);
  });

  it("plus de 20 headers → rejeté", async () => {
    const ws = await signUpTestUser();
    const headers = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`h${i}`, "v"])
    );
    await expect(
      createGaugeSource(ws.workspaceId, { name: "x", url: "https://example.com", kind: "quota", headers })
    ).rejects.toThrow(/headers/);
  });

  it("valeur de header trop longue (> 500) → rejetée", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, {
        name: "x", url: "https://example.com", kind: "quota",
        headers: { "x-api-key": "a".repeat(501) },
      })
    ).rejects.toThrow(/headers/);
  });

  it("name manquant → rejeté", async () => {
    const ws = await signUpTestUser();
    await expect(
      createGaugeSource(ws.workspaceId, { name: "", url: "https://example.com", kind: "quota" })
    ).rejects.toThrow(/name/);
  });

  // Durcissement (re-review de la vague finale) : POST /api/gauges (création
  // d'une source) renvoyait `NextResponse.json(source)` — la ligne brute de
  // createGaugeSource, headers en clair inclus — alors que GET et PATCH
  // étaient déjà redigés via redactHeadersForClient. 3e chemin de fuite,
  // même contrat que celui documenté sur updateGaugeSource ci-dessous : la
  // route applique désormais redactHeadersForClient à la réponse. Comme pour
  // PATCH, testé au niveau lib (le plus proche possible de la route dans ce
  // repo) plutôt qu'en appelant le handler Next.js directement.
  it("redactHeadersForClient appliqué à la ligne createGaugeSource (route POST) : plus de valeur de header, seulement la clé", async () => {
    const ws = await signUpTestUser();
    const created = await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: "https://example.com", kind: "quota",
      headers: { "x-api-key": "secret-jamais-renvoye-au-post" },
    });
    const redacted = redactHeadersForClient(created);

    expect(redacted).not.toHaveProperty("headers");
    expect(redacted.headerKeys).toEqual(["x-api-key"]);
    expect(JSON.stringify(redacted)).not.toContain("secret-jamais-renvoye-au-post");
  });
});

describe("listGaugeSources / getGaugeSource / updateGaugeSource / deleteGaugeSource — cloisonnement", () => {
  it("une source du workspace A est invisible et non modifiable depuis B", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const source = await createGaugeSource(a.workspaceId, {
      name: "Bridge A", url: "https://a.example.com", kind: "quota",
    });

    expect((await listGaugeSources(a.workspaceId)).map((s) => s.id)).toContain(source.id);
    expect((await listGaugeSources(b.workspaceId)).map((s) => s.id)).not.toContain(source.id);
    expect(await getGaugeSource(b.workspaceId, source.id)).toBeNull();
    expect(await updateGaugeSource(b.workspaceId, source.id, { enabled: false })).toBeNull();
    expect(await deleteGaugeSource(b.workspaceId, source.id)).toBeNull();

    // toujours là, intacte, côté A
    const stillThere = await getGaugeSource(a.workspaceId, source.id);
    expect(stillThere?.enabled).toBe(true);
  });

  it("updateGaugeSource bascule enabled", async () => {
    const ws = await signUpTestUser();
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: "https://example.com", kind: "quota",
    });
    const updated = await updateGaugeSource(ws.workspaceId, source.id, { enabled: false });
    expect(updated?.enabled).toBe(false);
  });

  // Durcissement (revue finale, vague cockpit) : PATCH /api/gauges/[id]
  // (toggle enabled/disabled dans la page réglages) renvoyait la ligne
  // updateGaugeSource TELLE QUELLE au client, headers en clair inclus —
  // même fuite que GET avant son fix, juste déclenchée par un clic plutôt
  // qu'un poll. La route applique désormais redactHeadersForClient (comme
  // getGaugesState) : ce test prouve que la fonction retire bien la valeur
  // du header sur une ligne réelle issue d'updateGaugeSource.
  it("redactHeadersForClient appliqué à la ligne updateGaugeSource (route PATCH) : plus de valeur de header, seulement la clé", async () => {
    const ws = await signUpTestUser();
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: "https://example.com", kind: "quota",
      headers: { "x-api-key": "secret-jamais-renvoye-au-patch" },
    });
    const updated = await updateGaugeSource(ws.workspaceId, source.id, { enabled: false });
    const redacted = redactHeadersForClient(updated!);

    expect(redacted).not.toHaveProperty("headers");
    expect(redacted.headerKeys).toEqual(["x-api-key"]);
    expect(JSON.stringify(redacted)).not.toContain("secret-jamais-renvoye-au-patch");
  });

  it("deleteGaugeSource supprime définitivement", async () => {
    const ws = await signUpTestUser();
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: "https://example.com", kind: "quota",
    });
    const deleted = await deleteGaugeSource(ws.workspaceId, source.id);
    expect(deleted?.id).toBe(source.id);
    expect(await getGaugeSource(ws.workspaceId, source.id)).toBeNull();
  });
});

describe("refreshGauges — poller", () => {
  it("source conforme : persiste lastPayload + lastFetchedAt, lastError effacé", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({
      accounts: [{ id: "c1", usedPercent: 42, available: true }],
    }));
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: srv.url, kind: "quota",
    });

    await refreshGauges(ws.workspaceId);
    await srv.close();

    const [row] = await db.select().from(gaugeSources).where(eq(gaugeSources.id, source.id));
    expect(row.lastPayload).toEqual({ accounts: [{ id: "c1", usedPercent: 42, available: true }] });
    expect(row.lastError).toBeNull();
    expect(row.lastFetchedAt).not.toBeNull();
  });

  it("source malformée : lastError posé, jamais de throw", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ accounts: "nope" }));
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge cassé", url: srv.url, kind: "quota",
    });

    await expect(refreshGauges(ws.workspaceId)).resolves.not.toThrow();
    await srv.close();

    const [row] = await db.select().from(gaugeSources).where(eq(gaugeSources.id, source.id));
    expect(row.lastError).not.toBeNull();
  });

  it("ignore les sources enabled=false", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 10 }));
    const source = await createGaugeSource(ws.workspaceId, {
      name: "Bridge désactivé", url: srv.url, kind: "cost",
    });
    await updateGaugeSource(ws.workspaceId, source.id, { enabled: false });

    await refreshGauges(ws.workspaceId);
    await srv.close();

    expect(srv.hits()).toBe(0);
    const row = await getGaugeSource(ws.workspaceId, source.id);
    expect(row?.lastFetchedAt).toBeNull();
  });

  it("plusieurs sources : l'échec de l'une ne bloque pas la mise à jour des autres", async () => {
    const ws = await signUpTestUser();
    const ok = await startServer(jsonHandler({ costMonthlyEur: 99 }));
    const okSource = await createGaugeSource(ws.workspaceId, {
      name: "OK", url: ok.url, kind: "cost",
    });
    const downSource = await createGaugeSource(ws.workspaceId, {
      name: "Down", url: "http://127.0.0.1:1", kind: "cost",
    });

    await refreshGauges(ws.workspaceId);
    await ok.close();

    const rowOk = await getGaugeSource(ws.workspaceId, okSource.id);
    const rowDown = await getGaugeSource(ws.workspaceId, downSource.id);
    expect(rowOk?.lastPayload).toEqual({ costMonthlyEur: 99 });
    expect(rowOk?.lastError).toBeNull();
    expect(rowDown?.lastError).not.toBeNull();
  });

  it("cloisonnement : ne polle que les sources du workspace demandé", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const srvB = await startServer(jsonHandler({ costMonthlyEur: 1 }));
    await createGaugeSource(b.workspaceId, { name: "B", url: srvB.url, kind: "cost" });

    await refreshGauges(a.workspaceId);
    await srvB.close();

    expect(srvB.hits()).toBe(0);
  });
});

describe("getGaugesState — cache 5 minutes + coût total", () => {
  it("jamais fetchée (lastFetchedAt null) → refresh automatique même sans ?refresh", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ accounts: [{ id: "c1", usedPercent: 10 }] }));
    await createGaugeSource(ws.workspaceId, { name: "Bridge", url: srv.url, kind: "quota" });

    const state = await getGaugesState(ws.workspaceId, {});
    await srv.close();

    expect(srv.hits()).toBe(1);
    expect(state.sources[0].lastPayload).toEqual({ accounts: [{ id: "c1", usedPercent: 10 }] });
  });

  it("fraîche (<5 min) sans ?refresh → état stocké, pas de nouvel appel réseau", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 7 }));
    await createGaugeSource(ws.workspaceId, { name: "Bridge", url: srv.url, kind: "cost" });

    await getGaugesState(ws.workspaceId, {}); // 1er appel : refresh (jamais fetchée)
    await getGaugesState(ws.workspaceId, {}); // 2e appel : censé rester en cache
    await srv.close();

    expect(srv.hits()).toBe(1);
  });

  it("refresh=true force le refetch même si fraîche", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 7 }));
    await createGaugeSource(ws.workspaceId, { name: "Bridge", url: srv.url, kind: "cost" });

    await getGaugesState(ws.workspaceId, {});
    await getGaugesState(ws.workspaceId, { refresh: true });
    await srv.close();

    expect(srv.hits()).toBe(2);
  });

  it("lastFetchedAt vieux de plus de 5 min → refresh automatique sans ?refresh", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 7 }));
    const source = await createGaugeSource(ws.workspaceId, { name: "Bridge", url: srv.url, kind: "cost" });

    await getGaugesState(ws.workspaceId, {}); // fetch #1, pose lastFetchedAt = now
    await db.update(gaugeSources)
      .set({ lastFetchedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(gaugeSources.id, source.id));

    await getGaugesState(ws.workspaceId, {}); // doit re-fetch car périmé
    await srv.close();

    expect(srv.hits()).toBe(2);
  });

  it("coût total agrégé = somme des costMonthlyEur des sources cost (les quota n'y contribuent pas)", async () => {
    const ws = await signUpTestUser();
    const srvCostA = await startServer(jsonHandler({ costMonthlyEur: 100 }));
    const srvCostB = await startServer(jsonHandler({ costMonthlyEur: 250 }));
    const srvQuota = await startServer(jsonHandler({ accounts: [{ id: "c1", usedPercent: 50 }] }));
    await createGaugeSource(ws.workspaceId, { name: "A", url: srvCostA.url, kind: "cost" });
    await createGaugeSource(ws.workspaceId, { name: "B", url: srvCostB.url, kind: "cost" });
    await createGaugeSource(ws.workspaceId, { name: "Q", url: srvQuota.url, kind: "quota" });

    const state = await getGaugesState(ws.workspaceId, { refresh: true });
    await Promise.all([srvCostA.close(), srvCostB.close(), srvQuota.close()]);

    expect(state.totalCostEur).toBe(350);
  });

  it("une source désactivée ne contribue plus au coût total", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 100 }));
    const source = await createGaugeSource(ws.workspaceId, { name: "A", url: srv.url, kind: "cost" });
    await getGaugesState(ws.workspaceId, { refresh: true });
    await updateGaugeSource(ws.workspaceId, source.id, { enabled: false });

    const state = await getGaugesState(ws.workspaceId, {});
    await srv.close();

    expect(state.totalCostEur).toBe(0);
  });

  it("cloisonnement : sources et coût de B n'apparaissent pas dans l'état de A", async () => {
    const a = await signUpTestUser();
    const b = await signUpTestUser();
    const srvB = await startServer(jsonHandler({ costMonthlyEur: 500 }));
    await createGaugeSource(b.workspaceId, { name: "B", url: srvB.url, kind: "cost" });

    const stateA = await getGaugesState(a.workspaceId, {});
    await srvB.close();

    expect(stateA.sources).toEqual([]);
    expect(stateA.totalCostEur).toBe(0);
  });

  // Durcissement (vague finale) : GET /api/gauges est pollé EN CLAIR par le
  // navigateur toutes les 5 min (SubscriptionGauges) — un x-api-key posé
  // dans `headers` à la création ne doit JAMAIS y réapparaître.
  it("headers JAMAIS exposés en clair : seules les CLÉS sortent, jamais les valeurs (x-api-key)", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 1 }));
    await createGaugeSource(ws.workspaceId, {
      name: "Bridge", url: srv.url, kind: "cost",
      headers: { "x-api-key": "secret-ne-doit-jamais-sortir" },
    });

    const state = await getGaugesState(ws.workspaceId, {});
    await srv.close();

    const source = state.sources[0] as unknown as Record<string, unknown>;
    expect(source).not.toHaveProperty("headers");
    expect(source.headerKeys).toEqual(["x-api-key"]);
    // Preuve POSITIVE, pas juste l'absence du champ attendu : le secret
    // n'apparaît nulle part dans le JSON sérialisé de l'état entier.
    expect(JSON.stringify(state)).not.toContain("secret-ne-doit-jamais-sortir");
  });

  it("source sans headers configurés → headerKeys vide", async () => {
    const ws = await signUpTestUser();
    const srv = await startServer(jsonHandler({ costMonthlyEur: 1 }));
    await createGaugeSource(ws.workspaceId, { name: "Bridge", url: srv.url, kind: "cost" });

    const state = await getGaugesState(ws.workspaceId, {});
    await srv.close();

    expect((state.sources[0] as unknown as { headerKeys: string[] }).headerKeys).toEqual([]);
  });
});
