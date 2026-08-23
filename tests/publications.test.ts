import { describe, it, expect } from "vitest";
import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate, resolveProposed, heartbeatEditing, getContent } from "@/lib/contents";
import { listJobs, claimJob, failJob } from "@/lib/jobs";
import {
  bodyHash, listPublications, linkPublication, markSynced, setPublicationError,
} from "@/lib/publications";

async function contentIn(ws: { workspaceId: string }, body = "# T\n\ncorps") {
  const idea = await createIdea(ws.workspaceId, { title: "I" });
  const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
  await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body, authorType: "user" });
  return contentId;
}

describe("publications — lib", () => {
  it("linkPublication upsert sur (content, target) ; listPublications filtre ; cloisonnement", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const p1 = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "42", url: "https://c.test/post/42", meta: { space: "actus-ia" }, bodyHash: bodyHash("# T\n\ncorps") });
    expect(p1.publishedAt).not.toBeNull();
    expect(p1.syncedAt).not.toBeNull();
    const p2 = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "42", url: "https://c.test/post/42-bis", bodyHash: "h2" });
    expect(p2.id).toBe(p1.id);
    expect(p2.url).toBe("https://c.test/post/42-bis");
    expect(p2.publishedAt!.getTime()).toBe(p1.publishedAt!.getTime());
    expect(await listPublications(ws.workspaceId, { contentId })).toHaveLength(1);
    expect(await listPublications(ws.workspaceId, { target: "autre" })).toHaveLength(0);
    const b = await signUpTestUser();
    expect(await listPublications(b.workspaceId, {})).toHaveLength(0);
    await expect(linkPublication(b.workspaceId, { contentId, target: "x", externalId: "1", bodyHash: "h" })).rejects.toThrow(/introuvable/);
  });

  it("markSynced met à jour hash + syncedAt et efface last_error ; setPublicationError pose last_error", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws);
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: "h1" });
    const err = await setPublicationError(ws.workspaceId, p.id, "403 depuis la cible");
    expect(err!.lastError).toBe("403 depuis la cible");
    const ok = await markSynced(ws.workspaceId, p.id, "h2");
    expect(ok!.publishedBodyHash).toBe("h2");
    expect(ok!.lastError).toBeNull();
    const b = await signUpTestUser();
    expect(await markSynced(b.workspaceId, p.id, "h3")).toBeNull();
  });
});

describe("publications — hook « publié puis modifié »", () => {
  it("révision courante sur un contenu publié au hash différent → UN job sync coalescé ; révision identique au hash → aucun", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: bodyHash("# T\n\nv1") });
    // même corps : rien
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv1", authorType: "user" });
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(0);
    // rafale d'autosauvegardes : un seul queued
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv2", authorType: "user" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv3", authorType: "user" });
    const syncs = await listJobs(ws.workspaceId, { kind: "sync" });
    expect(syncs).toHaveLength(1);
    expect(syncs[0].payload).toEqual({ publication_id: p.id, target: "fluentcommunity" });
    expect(syncs[0].requestedBy).toBe("system:publication-sync");
    // un sync running + nouvelle édition → un second queued (rattrapage)
    await claimJob(ws.workspaceId, syncs[0].id, "w");
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv4", authorType: "user" });
    expect(await listJobs(ws.workspaceId, { kind: "sync", status: "queued" })).toHaveLength(1);
  });

  it("une révision proposed (agent pendant édition humaine) ne crée rien ; son acceptation, si", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: bodyHash("# T\n\nv1") });
    await heartbeatEditing(ws.workspaceId, contentId); // l'humain édite → écriture agent = proposed
    const r = await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nagent", authorType: "agent" });
    expect(r.state).toBe("proposed");
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(0);
    const c = await getContent(ws.workspaceId, contentId);
    await resolveProposed({ workspaceId: ws.workspaceId, contentId, revisionId: r.revisionId, action: "accept", expectedCurrentRevisionId: c!.currentRevisionId });
    expect(await listJobs(ws.workspaceId, { kind: "sync" })).toHaveLength(1);
  });

  it("fail_job d'un sync pose last_error sur la publication du payload", async () => {
    const ws = await signUpTestUser();
    const contentId = await contentIn(ws, "# T\n\nv1");
    const p = await linkPublication(ws.workspaceId, { contentId, target: "fluentcommunity", externalId: "1", bodyHash: "autre" });
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nv2", authorType: "user" });
    const [job] = await listJobs(ws.workspaceId, { kind: "sync" });
    await claimJob(ws.workspaceId, job.id, "w");
    await failJob(ws.workspaceId, job.id, "FluentCommunity 500");
    const [pub] = await listPublications(ws.workspaceId, { contentId });
    expect(pub.lastError).toBe("FluentCommunity 500");
    expect(pub.id).toBe(p.id);
  });
});
