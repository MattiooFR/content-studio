import { describe, it, expect } from "vitest";
import path from "node:path";
import { NextRequest } from "next/server";
import { POST as clipPOST } from "@/app/api/clip/route";
import { signUpTestUser } from "./helpers";
import { generateMcpToken } from "@/lib/tenant";
import { getIdea } from "@/lib/ideas";
import { getSource, attachExtraction } from "@/lib/sources";
import {
  createContentDraft, applyContentUpdate, setContentStatus, getContent, listRevisions,
} from "@/lib/contents";
import { computeFunnel } from "@/lib/funnel";
import { createLane, setLaneCommand, getLane } from "@/lib/lanes";
import { runLaneMessage, type LaneRunEvent } from "@/lib/lane-runner";
import { bus, type WorkspaceEvent } from "@/lib/events";

// CLI FACTICE UNIQUEMENT — jamais le vrai `claude` dans les tests (cf.
// tests/fixtures/fake-cli.sh, réutilisé tel quel depuis lanes.test.ts).
const FAKE_CLI = path.join(process.cwd(), "tests/fixtures/fake-cli.sh");

function clipRequest(body: Record<string, unknown>, token: string) {
  return new NextRequest("http://localhost:3003/api/clip", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/**
 * e2e lib-level du fil COMPLET de la vague cockpit (Phases A → D), même
 * esprit que tests/e2e-flow.test.ts (critère de fin v1) : un seul test qui
 * traverse tout le pipeline, assertions à chaque étape plutôt qu'à la fin
 * seulement. Comme l'e2e v1, l'"agent" est simulé par des appels DIRECTS aux
 * libs (jamais un modèle invoqué par l'outil) — la seule vraie exécution de
 * process de toute la suite est la lane, et elle passe par la fixture
 * fake-cli.sh, jamais par un CLI réel.
 */
describe("e2e cockpit : clip → source → contenu (rejeté + publié) → funnel → lane (fixture) → révision lane:<id>", () => {
  it("le fil complet de la vague cockpit", async () => {
    // ---- Phase A.2 : clip -----------------------------------------------
    // Un humain (ou l'extension Chrome) clippe une page : POST /api/clip
    // avec un token MCP RÉEL généré via la lib (même mécanique que
    // resolveMcpToken utilisé par l'agent) — crée idée (inbox) + source
    // (kind url, status pending) en une seule transaction.
    const ws = await signUpTestUser();
    const { token } = await generateMcpToken(ws.workspaceId, "cockpit-e2e");

    const clipRes = await clipPOST(clipRequest({
      url: "https://example.com/article-cockpit",
      title: "Article source du cockpit",
      selection: "Extrait clippé pour amorcer l'idée.",
    }, token));
    expect(clipRes.status).toBe(200);
    const { ideaId, sourceId } = await clipRes.json() as { ideaId: string; sourceId: string };

    const idea = await getIdea(ws.workspaceId, ideaId);
    expect(idea?.status).toBe("inbox");
    const sourcePending = await getSource(ws.workspaceId, sourceId);
    expect(sourcePending?.status).toBe("pending");
    expect(sourcePending?.ref).toBe("https://example.com/article-cockpit");

    // ---- Phase A.1 : l'agent extrait la source ---------------------------
    // Appel de lib DIRECT (attachExtraction), comme l'e2e v1 : l'outil
    // stocke, l'extraction vient de l'agent — jamais un appel de modèle ici.
    const extracted = await attachExtraction(ws.workspaceId, sourceId, {
      extractedText: "Le texte long extrait par l'agent depuis la page clippée.",
      extractedMeta: { wordCount: 9 },
    });
    expect(extracted?.status).toBe("extracted");
    expect(extracted?.extractedText).toContain("extrait par l'agent");

    // ---- Phase B (partie 1) : un contenu community écrit puis REJETÉ -----
    const { contentId: rejectedContentId } = await createContentDraft({
      workspaceId: ws.workspaceId, ideaId, channelKey: "community",
    });
    const draft1 = await applyContentUpdate({
      workspaceId: ws.workspaceId, contentId: rejectedContentId,
      body: "# Premier jet\n\nTrop générique, à refaire.",
      authorType: "agent", authorLabel: "cockpit-e2e",
    });
    expect(draft1.state).toBe("current");
    await setContentStatus(ws.workspaceId, rejectedContentId, "rejected");
    expect((await getContent(ws.workspaceId, rejectedContentId))?.status).toBe("rejected");

    // ---- Phase B (partie 2) : un second contenu, même idée, PUBLIÉ -------
    const { contentId: publishedContentId } = await createContentDraft({
      workspaceId: ws.workspaceId, ideaId, channelKey: "community",
    });
    const draft2 = await applyContentUpdate({
      workspaceId: ws.workspaceId, contentId: publishedContentId,
      body: "# Deuxième jet\n\nMéthode, exemples concrets, question finale.",
      authorType: "agent", authorLabel: "cockpit-e2e",
    });
    expect(draft2.state).toBe("current");
    await setContentStatus(ws.workspaceId, publishedContentId, "published");
    const publishedContent = await getContent(ws.workspaceId, publishedContentId);
    expect(publishedContent?.status).toBe("published");
    expect(publishedContent?.body).toContain("Deuxième jet");

    // ---- Phase B : le funnel reflète EXACTEMENT cet état -----------------
    // Canal community de ce workspace : une seule idée (2 contenus dessus),
    // aucun draft/review restant (les deux ont bougé), 1 rejected, 1 published.
    const funnel = await computeFunnel(ws.workspaceId);
    const community = funnel.find((r) => r.channelKey === "community");
    expect(community).toBeTruthy();
    expect(community?.ideas).toBe(1);
    expect(community?.drafts).toBe(0);
    expect(community?.inReview).toBe(0);
    expect(community?.approved).toBe(0);
    expect(community?.published).toBe(1);
    expect(community?.rejected).toBe(1);

    // ---- Phase D : une lane exécutée via la FIXTURE (jamais le vrai CLI) -
    // timeoutMs/killGraceMs courts injectés par prudence : la fixture répond
    // quasi instantanément en usage nominal, mais aucun test de cette suite
    // ne doit pouvoir dépendre du timeout par défaut du module (120 s).
    await setLaneCommand(ws.workspaceId, FAKE_CLI);
    const lane = await createLane(ws.workspaceId, { title: "Retouche du post communauté" });

    const laneEvents: LaneRunEvent[] = [];
    const busEvents: WorkspaceEvent[] = [];
    const unsubscribe = bus.subscribe(ws.workspaceId, (e) => busEvents.push(e));
    await runLaneMessage({
      workspaceId: ws.workspaceId, laneId: lane.id,
      userMessage: "Améliore le post communauté publié.",
      onEvent: (e) => laneEvents.push(e),
      timeoutMs: 5000, killGraceMs: 500,
    });
    unsubscribe();

    expect(laneEvents.at(-1)).toEqual({ type: "done" });
    expect(laneEvents.some((e) => e.type === "chunk")).toBe(true);
    expect(busEvents.some((e) => e.type === "lane.message")).toBe(true);

    const laneAfterRun = await getLane(ws.workspaceId, lane.id);
    expect(laneAfterRun?.status).toBe("idle");
    // session_id fixe de la fixture (fake-session-fixed-001) : preuve que le
    // runner a bien parsé le stream-json et persisté la session, pas juste
    // exécuté un process quelconque.
    expect(laneAfterRun?.cliSessionId).toBe("fake-session-fixed-001");

    // ---- Phase D : révision portant authorLabel lane:<id> ----------------
    // Comme le ferait le vrai CLI via l'outil MCP update_content(lane_id=…)
    // pendant cette conversation : applyContentUpdate avec laneId pose
    // authorLabel = "lane:<id>" (RevisionsPanel, W11, y détecte "ouvrir la
    // conversation").
    const laneWrite = await applyContentUpdate({
      workspaceId: ws.workspaceId, contentId: publishedContentId,
      body: "# Deuxième jet, retouché par la lane\n\nMéthode affinée pendant la conversation.",
      authorType: "agent", laneId: lane.id,
    });
    const revisions = await listRevisions(ws.workspaceId, publishedContentId);
    const laneRevision = revisions.find((r) => r.id === laneWrite.revisionId);
    expect(laneRevision?.authorLabel).toBe(`lane:${lane.id}`);

    const finalContent = await getContent(ws.workspaceId, publishedContentId);
    expect(finalContent?.body).toContain("retouché par la lane");
  });
});
