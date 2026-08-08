import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildMentionMarker, resolveMessageForCli, resolveLaneOpenOutcome, type MentionRef,
} from "@/components/cockpit/chat-drawer";

// Task W11 fix round 1 — la revue a trouvé que l'ancien format
// `[titre](cs://idea/<uuid>)` cassait dès qu'un titre contenait `]` (texte
// libre, cf. src/lib/ideas.ts — aucune contrainte, et l'ingestion
// drop-anything ramène des titres de pages web pleins de crochets) :
// MENTION_MARKER_RE ne matchait plus, et `cs://idea/<uuid>)` partait EN
// CLAIR vers le CLI. C'est CE test qui manquait à la suite W11 : ces cas ne
// sont pas testés ailleurs.
//
// Le nouveau design résout par une table {token → référence} (état React
// dans ChatDrawerProvider), jamais par un regex qui ré-parse le label —
// donc un titre ne peut plus jamais casser la résolution, quel que soit son
// contenu. Ces tests exercent buildMentionMarker/resolveMessageForCli tels
// qu'exportés du composant, avec une table de résolution construite à la
// main (équivalent de ce que `registerMentionRef` pose en React state).

const IDEA_ID = "11111111-1111-1111-1111-111111111111";
const CONTENT_ID = "22222222-2222-2222-2222-222222222222";

function mockFetchJson(byPath: Record<string, { status: number; body?: unknown }>) {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    const match = Object.entries(byPath).find(([path]) => url.endsWith(path));
    if (!match) return new Response("not found", { status: 404 });
    const [, { status, body } ] = match;
    return new Response(body !== undefined ? JSON.stringify(body) : undefined, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMentionMarker — jeton opaque, indépendant du titre", () => {
  it("le marqueur ne contient jamais le label, quel que soit son contenu", () => {
    expect(buildMentionMarker("1")).toBe("@⟦1⟧");
    expect(buildMentionMarker("42")).toBe("@⟦42⟧");
  });
});

describe("resolveMessageForCli — robuste à tout titre, jamais de cs:// en fuite", () => {
  it("titre contenant ']' : la référence résout quand même le bon contenu", async () => {
    mockFetchJson({
      [`/api/ideas/${IDEA_ID}`]: { status: 200, body: { title: "[SEO] Article", notes: "Notes de l'idée SEO." } },
    });
    const refs = new Map<string, MentionRef>([
      ["1", { type: "idea", id: IDEA_ID, label: "[SEO] Article" }],
    ]);
    const raw = `Regarde ${buildMentionMarker("1")} et dis-moi ce que tu en penses`;
    const resolved = await resolveMessageForCli(raw, refs);

    expect(resolved).not.toContain("cs://");
    expect(resolved).toContain("Notes de l'idée SEO.");
    expect(resolved).toContain("Idée — [SEO] Article");
    expect(resolved).toContain("dis-moi ce que tu en penses");
  });

  it("titres contenant ')' et '(' résolvent aussi correctement", async () => {
    mockFetchJson({
      [`/api/contents/${CONTENT_ID}`]: {
        status: 200,
        body: { body: "Corps du contenu.", channel: { name: "X" } },
      },
    });
    const refs = new Map<string, MentionRef>([
      ["7", { type: "content", id: CONTENT_ID, label: "Draft (v2) — brouillon" }],
    ]);
    const raw = `${buildMentionMarker("7")} merci`;
    const resolved = await resolveMessageForCli(raw, refs);

    expect(resolved).not.toContain("cs://");
    expect(resolved).toContain("Corps du contenu.");
    expect(resolved).toContain("Draft (v2) — brouillon");
  });

  it("DEUX références dans le même message (dont un titre à crochets) résolvent chacune le bon contenu, sans AUCUN cs://", async () => {
    mockFetchJson({
      [`/api/ideas/${IDEA_ID}`]: { status: 200, body: { title: "[SEO] Article", notes: "Notes idée un." } },
      [`/api/contents/${CONTENT_ID}`]: { status: 200, body: { body: "Corps du contenu deux.", channel: null } },
    });
    const refs = new Map<string, MentionRef>([
      ["1", { type: "idea", id: IDEA_ID, label: "[SEO] Article" }],
      ["2", { type: "content", id: CONTENT_ID, label: "Post normal" }],
    ]);
    const raw = `${buildMentionMarker("1")} et aussi ${buildMentionMarker("2")} stp`;
    const resolved = await resolveMessageForCli(raw, refs);

    expect(resolved).not.toMatch(/cs:\/\//);
    // chaque référence a résolu le contexte du BON contenu (pas mélangé)
    expect(resolved).toContain("Notes idée un.");
    expect(resolved).toContain("Idée — [SEO] Article");
    expect(resolved).toContain("Corps du contenu deux.");
    expect(resolved).toContain("Post normal");
    expect(resolved).toContain("stp");
  });

  it("jeton absent de la table (référence supprimée/inconnue) est retiré sans jamais produire de cs://", async () => {
    mockFetchJson({});
    const raw = `salut ${buildMentionMarker("999")} !`;
    const resolved = await resolveMessageForCli(raw, new Map());

    expect(resolved).not.toContain("cs://");
    expect(resolved).not.toContain("⟦");
    expect(resolved).not.toContain("⟧");
  });

  it("aucune référence dans le message : renvoyé tel quel", async () => {
    const resolved = await resolveMessageForCli("juste un message normal, rien à résoudre", new Map());
    expect(resolved).toBe("juste un message normal, rien à résoudre");
  });

  it("même référence citée deux fois (deux jetons distincts) : un seul bloc de contexte, pas de doublon", async () => {
    const fetchMock = mockFetchJson({
      [`/api/ideas/${IDEA_ID}`]: { status: 200, body: { title: "Idée X", notes: "Notes X." } },
    });
    const refs = new Map<string, MentionRef>([
      ["1", { type: "idea", id: IDEA_ID, label: "Idée X" }],
      ["2", { type: "idea", id: IDEA_ID, label: "Idée X" }],
    ]);
    const raw = `${buildMentionMarker("1")} puis encore ${buildMentionMarker("2")}`;
    const resolved = await resolveMessageForCli(raw, refs);

    expect(fetchMock).toHaveBeenCalledTimes(1); // dédoublonné par (type, id)
    expect(resolved.match(/### Idée — Idée X/g)?.length).toBe(1);
  });

  it("troncature du contexte au-delà de 2000 caractères", async () => {
    const longNotes = "x".repeat(2100);
    mockFetchJson({
      [`/api/ideas/${IDEA_ID}`]: { status: 200, body: { title: "Idée longue", notes: longNotes } },
    });
    const refs = new Map<string, MentionRef>([
      ["1", { type: "idea", id: IDEA_ID, label: "Idée longue" }],
    ]);
    const resolved = await resolveMessageForCli(buildMentionMarker("1"), refs);
    expect(resolved).toContain("x".repeat(2000) + "…");
    expect(resolved).not.toContain("x".repeat(2001));
  });
});

describe("resolveLaneOpenOutcome — lien vers une lane inexistante/périmée (Minor de la revue)", () => {
  it("lane présente dans la liste chargée → found", () => {
    const outcome = resolveLaneOpenOutcome(
      [{ id: "lane-1" }, { id: "lane-2" }],
      "lane-2",
    );
    expect(outcome.found).toBe(true);
  });

  it("lane absente (supprimée / autre workspace) → message d'erreur visible, pas un échec muet", () => {
    const outcome = resolveLaneOpenOutcome([{ id: "lane-1" }], "lane-inconnue");
    expect(outcome.found).toBe(false);
    if (!outcome.found) expect(outcome.message).toMatch(/introuvable/i);
  });

  it("liste vide → non trouvée", () => {
    const outcome = resolveLaneOpenOutcome([], "quoi-que-ce-soit");
    expect(outcome.found).toBe(false);
  });
});
