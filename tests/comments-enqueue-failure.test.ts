import { describe, it, expect, vi } from "vitest";

// comments.ts importe createJob (et le type Job, effacé à la compilation)
// statiquement depuis @/lib/jobs : on le remplace ici par un mock qui échoue
// systématiquement, pour prouver que createVoiceComment bascule le
// commentaire déjà committé en « failed » plutôt que de le laisser pending
// sans job et sans recours (Finding 2, review Task 12). Fichier dédié : ce
// mock ne doit pas s'appliquer aux autres tests (jobs.test.ts, publications
// via enqueueSyncIfStale) qui ont besoin du vrai module.
vi.mock("@/lib/jobs", () => ({
  createJob: vi.fn(async () => {
    throw new Error("boom: création du job a échoué");
  }),
}));

import { signUpTestUser } from "./helpers";
import { createIdea } from "@/lib/ideas";
import { createContentDraft, applyContentUpdate } from "@/lib/contents";
import { createVoiceComment, getCommentAudio, listComments } from "@/lib/comments";

describe("createVoiceComment — createJob échoue après le commit comment+audio", () => {
  it("bascule le commentaire en failed (audio conservé) et propage l'erreur", async () => {
    const ws = await signUpTestUser();
    const idea = await createIdea(ws.workspaceId, { title: "I" });
    const { contentId } = await createContentDraft({ workspaceId: ws.workspaceId, ideaId: idea.id, channelKey: "community" });
    // content SANS publication liée : enqueueSyncIfStale (appelé par
    // applyContentUpdate) ne parcourt donc aucune publication et n'appelle
    // jamais createJob — le mock ci-dessus ne perturbe pas cette écriture.
    await applyContentUpdate({ workspaceId: ws.workspaceId, contentId, body: "# T\n\nUn passage à commenter.", authorType: "user" });

    await expect(
      createVoiceComment(ws.workspaceId, { contentId, audio: Buffer.from("a"), mime: "audio/webm" })
    ).rejects.toThrow(/boom/);

    // Le commentaire + l'audio ont bien été committés avant l'échec de
    // createJob (transaction séparée, cf. comments.ts) : on doit pouvoir le
    // retrouver, transcription basculée en failed, audio conservé.
    const comments = await listComments(ws.workspaceId, contentId, {});
    expect(comments).toHaveLength(1);
    expect(comments[0].kind).toBe("voice");
    expect(comments[0].transcription).toBe("failed");
    expect(await getCommentAudio(ws.workspaceId, comments[0].id)).not.toBeNull();
  });
});
