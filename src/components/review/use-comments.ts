"use client";
import { useCallback, useEffect, useState } from "react";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export type CommentRow = {
  id: string; quote: string; prefix: string; suffix: string; section: string; body: string;
  kind: "text" | "voice"; status: "open" | "applied" | "resolved";
  transcription: "none" | "pending" | "done" | "failed"; createdAt: string;
};
export type Anchor = { quote: string; prefix: string; suffix: string; section: string };

/**
 * Les commentaires d'un contenu, tenus à jour par SSE (`comment.updated`) —
 * jamais de polling. Chaque action (création, modification, suppression)
 * rafraîchit aussi la liste tout de suite : l'événement du bus rejoue derrière
 * sans conséquence, mais l'UI ne dépend pas de lui pour être juste.
 */
export function useComments(contentId: string) {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/contents/${contentId}/comments`);
    if (r.ok) setComments(await r.json());
  }, [contentId]);
  useEffect(() => { refresh(); }, [refresh]);
  useWorkspaceEvents((e) => {
    if (e.type === "comment.updated" && e.contentId === contentId) refresh();
  });

  // message d'erreur de la route si elle en donne un, fallback sinon
  const fail = useCallback(async (res: Response, fallback: string) => {
    const { error: m } = await res.json().catch(() => ({ error: null }));
    setError(typeof m === "string" ? m : fallback);
  }, []);

  const createText = useCallback(async (body: string, anchor: Anchor | null) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, ...(anchor ?? {}) }),
    });
    if (!res.ok) { await fail(res, "Échec de l'enregistrement du commentaire."); return null; }
    const row = (await res.json()) as CommentRow;
    await refresh();
    return row;
  }, [contentId, refresh, fail]);

  const createVoice = useCallback(async (blob: Blob, mime: string, anchor: Anchor | null) => {
    setError(null);
    // l'ancrage passe en query string : le corps de la requête EST l'audio
    const q = new URLSearchParams();
    if (anchor) for (const [k, v] of Object.entries(anchor)) q.set(k, v);
    const res = await fetch(`/api/contents/${contentId}/comments/audio?${q}`, {
      method: "POST", headers: { "content-type": mime }, body: blob,
    });
    if (!res.ok) { await fail(res, "Échec de l'envoi de la dictée."); return null; }
    const { comment } = (await res.json()) as { comment: CommentRow };
    await refresh();
    return comment;
  }, [contentId, refresh, fail]);

  const update = useCallback(async (id: string, patch: { body?: string; status?: CommentRow["status"] }) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch),
    });
    if (!res.ok) await fail(res, "Échec de la mise à jour du commentaire.");
    await refresh();
  }, [contentId, refresh, fail]);

  const remove = useCallback(async (id: string) => {
    setError(null);
    const res = await fetch(`/api/contents/${contentId}/comments/${id}`, { method: "DELETE" });
    if (!res.ok) await fail(res, "Échec de la suppression du commentaire.");
    await refresh();
  }, [contentId, refresh, fail]);

  return { comments, error, refresh, createText, createVoice, update, remove };
}
