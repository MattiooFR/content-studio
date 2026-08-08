import { describe, it, expect } from "vitest";
import {
  createContentDraft, applyContentUpdate, heartbeatEditing,
  resolveProposed, getContent, listRevisions,
} from "@/lib/contents";
import { bus, type WorkspaceEvent } from "@/lib/events";
import { createIdea } from "@/lib/ideas";
import { createPersona } from "@/lib/personas";
import { createLane } from "@/lib/lanes";
import { signUpTestUser } from "./helpers";


async function fixture() {
  const ws = await signUpTestUser();
  const idea = await createIdea(ws.workspaceId, { title: "Tuto Codex" });
  const { contentId } = await createContentDraft({
    workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community",
  });
  return { ...ws, ideaId: idea.id, contentId };
}

describe("révisions", () => {
  it("écriture agent hors édition → current, body à jour", async () => {
    const f = await fixture();
    const r = await applyContentUpdate({
      workspaceId: f.workspaceId, contentId: f.contentId,
      body: "# v1", authorType: "agent", authorLabel: "claude",
    });
    expect(r.state).toBe("current");
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("# v1");
    expect(c?.currentRevisionId).toBe(r.revisionId);
  });

  it("écriture agent PENDANT édition → proposed, body intact", async () => {
    const f = await fixture();
    await applyContentUpdate({
      workspaceId: f.workspaceId, contentId: f.contentId,
      body: "humain", authorType: "user",
    });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const r = await applyContentUpdate({
      workspaceId: f.workspaceId, contentId: f.contentId,
      body: "agent pendant édition", authorType: "agent",
    });
    expect(r.state).toBe("proposed");
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("humain"); // jamais d'écrasement silencieux
  });

  it("accept d'une proposed → elle devient current", async () => {
    const f = await fixture();
    const userRev = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain", authorType: "user" });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const prop = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "version agent", authorType: "agent" });
    await resolveProposed({
      workspaceId: f.workspaceId, contentId: f.contentId,
      revisionId: prop.revisionId, action: "accept",
      expectedCurrentRevisionId: userRev.revisionId,
    });
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("version agent");
    const states = (await listRevisions(f.workspaceId, f.contentId)).map((r) => r.state);
    expect(states.filter((s) => s === "current")).toHaveLength(1);
  });

  it("reject d'une proposed → superseded, AUCUN événement SSE publié (la current n'a pas bougé)", async () => {
    const f = await fixture();
    await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain", authorType: "user" });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const prop = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "proposition rejetée", authorType: "agent" });

    const received: WorkspaceEvent[] = [];
    const unsubscribe = bus.subscribe(f.workspaceId, (e) => received.push(e));
    await resolveProposed({
      workspaceId: f.workspaceId, contentId: f.contentId,
      revisionId: prop.revisionId, action: "reject",
    });
    unsubscribe();

    // publier ici mentirait : "current" alors que rien n'est devenu courant.
    // v1 actée — les autres onglets voient le reject au prochain load.
    expect(received).toHaveLength(0);
    const revs = await listRevisions(f.workspaceId, f.contentId);
    expect(revs.find((r) => r.id === prop.revisionId)?.state).toBe("superseded");
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("humain"); // la current n'a pas bougé
  });

  it("accept avec expectedCurrentRevisionId périmé → rejette, body reste le plus récent", async () => {
    const f = await fixture();
    const userRev1 = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain", authorType: "user" });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const prop = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "proposition", authorType: "agent" });
    // le user continue d'écrire APRÈS la proposition : la current a bougé sous nos pieds.
    await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain v2", authorType: "user" });
    await expect(
      resolveProposed({
        workspaceId: f.workspaceId, contentId: f.contentId,
        revisionId: prop.revisionId, action: "accept",
        expectedCurrentRevisionId: userRev1.revisionId,
      })
    ).rejects.toThrow(/périmée/);
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("humain v2");
  });

  it("accept FRAIS (expectedCurrentRevisionId à jour) → passe, body = version proposée", async () => {
    const f = await fixture();
    const userRev = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain", authorType: "user" });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const prop = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "version proposée", authorType: "agent" });
    await resolveProposed({
      workspaceId: f.workspaceId, contentId: f.contentId,
      revisionId: prop.revisionId, action: "accept",
      expectedCurrentRevisionId: userRev.revisionId,
    });
    const c = await getContent(f.workspaceId, f.contentId);
    expect(c?.body).toBe("version proposée");
  });

  it("deux proposeds sur le même contenu : accept de l'une (fraîche) supersede l'autre", async () => {
    const f = await fixture();
    const userRev = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "humain", authorType: "user" });
    await heartbeatEditing(f.workspaceId, f.contentId);
    const propA = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "proposition A", authorType: "agent" });
    const propB = await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body: "proposition B", authorType: "agent" });
    await resolveProposed({
      workspaceId: f.workspaceId, contentId: f.contentId,
      revisionId: propB.revisionId, action: "accept",
      expectedCurrentRevisionId: userRev.revisionId,
    });
    const revs = await listRevisions(f.workspaceId, f.contentId);
    const a = revs.find((r) => r.id === propA.revisionId);
    const b = revs.find((r) => r.id === propB.revisionId);
    expect(a?.state).toBe("superseded");
    expect(b?.state).toBe("current");
  });

  it("les révisions se succèdent proprement (current unique)", async () => {
    const f = await fixture();
    for (const body of ["a", "b", "c"]) {
      await applyContentUpdate({ workspaceId: f.workspaceId, contentId: f.contentId, body, authorType: "agent" });
    }
    const revs = await listRevisions(f.workspaceId, f.contentId);
    expect(revs).toHaveLength(3);
    expect(revs.filter((r) => r.state === "current")).toHaveLength(1);
    expect((await getContent(f.workspaceId, f.contentId))?.body).toBe("c");
  });

  it("cloisonnement : le contenu de A est introuvable depuis B", async () => {
    const f = await fixture();
    const b = await signUpTestUser();
    expect(await getContent(b.workspaceId, f.contentId)).toBeNull();
    await expect(
      applyContentUpdate({ workspaceId: b.workspaceId, contentId: f.contentId, body: "pirate", authorType: "agent" })
    ).rejects.toThrow();
  });

  it("createContentDraft avec l'ideaId d'un autre workspace → rejette", async () => {
    const f = await fixture();
    const b = await signUpTestUser();
    await expect(
      createContentDraft({ workspaceId: b.workspaceId, ideaId: f.ideaId, channelKey: "community" })
    ).rejects.toThrow(/idée introuvable/);
  });

  it("createContentDraft avec le persona_id d'un autre workspace → rejette", async () => {
    const f = await fixture();
    const b = await signUpTestUser();
    const bPersona = await createPersona(b.workspaceId, { name: "Persona B" });
    await expect(
      createContentDraft({
        workspaceId: f.workspaceId, ideaId: f.ideaId, channelKey: "community",
        personaId: bPersona.id,
      })
    ).rejects.toThrow(/persona introuvable/);
  });
});

// Task W11 : une écriture faite DEPUIS une conversation de lane (via l'outil
// MCP update_content, lane_id optionnel — ou le PATCH humain, même paramètre)
// tague sa révision `lane:<id>`, pour que la page contenu puisse offrir
// « ouvrir la conversation » dessus (RevisionsPanel détecte ce préfixe).
describe("applyContentUpdate — laneId → authorLabel lane:<id>", () => {
  it("laneId fourni : authorLabel devient lane:<id>, prend le pas sur authorLabel explicite", async () => {
    const f = await fixture();
    const lane = await createLane(f.workspaceId, { title: "Conversation test" });
    const r = await applyContentUpdate({
      workspaceId: f.workspaceId, contentId: f.contentId,
      body: "écrit depuis une lane", authorType: "agent",
      authorLabel: "mcp", // doit être écrasé par le format lane:<id>
      laneId: lane.id,
    });
    const revs = await listRevisions(f.workspaceId, f.contentId);
    const rev = revs.find((rv) => rv.id === r.revisionId);
    expect(rev?.authorLabel).toBe(`lane:${lane.id}`);
  });

  it("pas de laneId : authorLabel explicite inchangé (comportement W10 préservé)", async () => {
    const f = await fixture();
    const r = await applyContentUpdate({
      workspaceId: f.workspaceId, contentId: f.contentId,
      body: "écrit hors lane", authorType: "agent", authorLabel: "mcp",
    });
    const revs = await listRevisions(f.workspaceId, f.contentId);
    expect(revs.find((rv) => rv.id === r.revisionId)?.authorLabel).toBe("mcp");
  });

  it("laneId d'un AUTRE workspace → rejette, rien n'est écrit (cloisonnement)", async () => {
    const f = await fixture();
    const other = await signUpTestUser();
    const otherLane = await createLane(other.workspaceId, { title: "Lane d'un autre workspace" });
    const before = await listRevisions(f.workspaceId, f.contentId);
    await expect(
      applyContentUpdate({
        workspaceId: f.workspaceId, contentId: f.contentId,
        body: "ne doit jamais atterrir", authorType: "agent",
        laneId: otherLane.id,
      })
    ).rejects.toThrow(/lane introuvable/);
    const after = await listRevisions(f.workspaceId, f.contentId);
    expect(after).toHaveLength(before.length); // aucune révision insérée
  });

  it("laneId inconnu (uuid random) → rejette de la même façon", async () => {
    const f = await fixture();
    await expect(
      applyContentUpdate({
        workspaceId: f.workspaceId, contentId: f.contentId,
        body: "x", authorType: "agent", laneId: crypto.randomUUID(),
      })
    ).rejects.toThrow(/lane introuvable/);
  });
});
