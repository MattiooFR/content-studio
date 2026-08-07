import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { contents } from "@/lib/db/schema";
import { computeFunnel } from "@/lib/funnel";
import { createIdea } from "@/lib/ideas";
import { createContentDraft } from "@/lib/contents";
import { signUpTestUser } from "./helpers";

async function contentOn(workspaceId: string, ideaTitle: string, channelKey: string) {
  const idea = await createIdea(workspaceId, { title: ideaTitle });
  const { contentId } = await createContentDraft({
    workspaceId, ideaId: idea.id, channelKey,
  });
  return { ideaId: idea.id, contentId };
}

async function setStatusRaw(contentId: string, status: string) {
  await db.update(contents).set({ status: status as never }).where(eq(contents.id, contentId));
}

async function ageContent(contentId: string, daysAgo: number) {
  const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await db.update(contents).set({ updatedAt: when }).where(eq(contents.id, contentId));
}

describe("computeFunnel — agrégat par canal", () => {
  it("agrège idées distinctes + statuts + bottleneck, canal par canal", async () => {
    const ws = await signUpTestUser();

    // --- canal "community" : 3 idées distinctes, statuts variés ---
    const a1c1 = await contentOn(ws.workspaceId, "Idée A1", "community");
    await setStatusRaw(a1c1.contentId, "draft");

    // deuxième contenu sur la MÊME idée (a1c1.ideaId) : sert à vérifier que
    // `ideas` compte des idées DISTINCTES, pas des contenus.
    const { contentId: a1c2b } = await createContentDraft({
      workspaceId: ws.workspaceId, ideaId: a1c1.ideaId, channelKey: "community",
    });
    await setStatusRaw(a1c2b, "review");
    await ageContent(a1c2b, 8); // vieilli : > 7 jours → goulot

    const a2 = await contentOn(ws.workspaceId, "Idée A2", "community");
    await setStatusRaw(a2.contentId, "review"); // frais, pas de goulot pour celui-ci
    const { contentId: a2Published } = await createContentDraft({
      workspaceId: ws.workspaceId, ideaId: a2.ideaId, channelKey: "community",
    });
    await setStatusRaw(a2Published, "published");

    const a3 = await contentOn(ws.workspaceId, "Idée A3", "community");
    await setStatusRaw(a3.contentId, "rejected");

    // --- canal "seo_article" : approved a sa PROPRE colonne (ne s'ajoute ni
    // à inReview ni à published), et l'idée compte quand même dans `ideas` ---
    const a4 = await contentOn(ws.workspaceId, "Idée A4", "seo_article");
    await setStatusRaw(a4.contentId, "draft");
    const { contentId: a4c2 } = await createContentDraft({
      workspaceId: ws.workspaceId, ideaId: a4.ideaId, channelKey: "seo_article",
    });
    await setStatusRaw(a4c2, "approved");

    // --- bruit d'un AUTRE workspace : ne doit fuiter nulle part ---
    const wsB = await signUpTestUser();
    const bIdea = await contentOn(wsB.workspaceId, "Idée B", "community");
    await setStatusRaw(bIdea.contentId, "review");
    await ageContent(bIdea.contentId, 30); // très vieux review, mais dans B

    const funnel = await computeFunnel(ws.workspaceId);

    const community = funnel.find((r) => r.channelKey === "community");
    const seo = funnel.find((r) => r.channelKey === "seo_article");
    const linkedin = funnel.find((r) => r.channelKey === "x_linkedin");

    expect(funnel.length).toBe(3); // les 3 canaux seeds du workspace, même sans contenu

    expect(community).toEqual({
      channelKey: "community",
      channelName: "Post communauté",
      ideas: 3, // A1, A2, A3 — distinctes (A1 a 2 contenus)
      drafts: 1,
      inReview: 2, // le vieilli + le frais
      approved: 0,
      published: 1,
      rejected: 1,
      bottleneck: "1 contenus en review depuis plus de 7 jours",
    });

    expect(seo).toEqual({
      channelKey: "seo_article",
      channelName: "Article SEO",
      ideas: 1, // A4 seule, malgré 2 contenus (draft + approved)
      drafts: 1,
      inReview: 0,
      approved: 1, // sa propre colonne — ne disparaît pas du pipeline
      published: 0,
      rejected: 0,
      bottleneck: null, // approved n'alimente aucun autre bucket, ni le goulot
    });

    expect(linkedin).toEqual({
      channelKey: "x_linkedin",
      channelName: "Post X / LinkedIn",
      ideas: 0,
      drafts: 0,
      inReview: 0,
      approved: 0,
      published: 0,
      rejected: 0,
      bottleneck: null,
    });

    // cloisonnement : le funnel de A ne voit rien de B
    const funnelB = await computeFunnel(wsB.workspaceId);
    const communityB = funnelB.find((r) => r.channelKey === "community");
    expect(communityB?.ideas).toBe(1);
    expect(communityB?.inReview).toBe(1);
    expect(communityB?.bottleneck).toBe("1 contenus en review depuis plus de 7 jours");
  });
});
