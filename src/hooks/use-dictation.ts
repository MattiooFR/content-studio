"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "@/hooks/use-recorder";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type DictationRow = {
  id: string; status: "pending" | "done" | "failed"; text: string;
  fieldKey: string; consumedAt: string | null; error: string | null;
};

/**
 * Dictée asynchrone d'un champ : enregistre, poste l'audio, puis livre le
 * texte à `onText` quand le worker a fini (SSE) — même si l'utilisateur a
 * continué à travailler entre-temps. `recover` = au montage, reprendre ce que
 * ce fieldKey attendait (reload pendant une transcription).
 */
export function useDictation({ fieldKey, onText, recover = true }: {
  fieldKey: string; onText: (text: string) => void; recover?: boolean;
}) {
  const { supported, recording, start, stop } = useRecorder();
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const delivered = useRef(new Set<string>());

  const deliver = useCallback(async (d: DictationRow) => {
    if (delivered.current.has(d.id)) return; // un seul dépôt par dictée, quel que soit le nombre d'événements
    delivered.current.add(d.id);
    onTextRef.current(d.text);
    setPendingIds((ids) => ids.filter((x) => x !== d.id));
    await fetch(`/api/dictations/${d.id}/consume`, { method: "POST" }).catch(() => { /* le tiroir la montrera « prête » */ });
  }, []);

  const send = useCallback(async (blob: Blob, mime: string) => {
    const res = await fetch(`/api/dictations?field_key=${encodeURIComponent(fieldKey)}`, {
      method: "POST", headers: { "content-type": mime }, body: blob,
    });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Envoi de la dictée impossible.");
      return;
    }
    const { id } = await res.json();
    setPendingIds((ids) => [...ids, id]);
  }, [fieldKey]);

  // Reprise au montage : ce que le champ attendait encore.
  useEffect(() => {
    if (!recover) return;
    let alive = true;
    fetch(`/api/dictations?field_key=${encodeURIComponent(fieldKey)}&open=1`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: DictationRow[]) => {
        if (!alive) return;
        for (const d of rows) {
          if (d.status === "done" && !d.consumedAt) deliver(d);
          else if (d.status === "pending") setPendingIds((ids) => (ids.includes(d.id) ? ids : [...ids, d.id]));
        }
      })
      .catch(() => { /* reprise impossible : le tiroir reste la source de vérité */ });
    return () => { alive = false; };
  }, [fieldKey, recover, deliver]);

  useWorkspaceEvents((e) => {
    if (e.type !== "dictation.updated" || e.fieldKey !== fieldKey) return;
    if (e.status === "done") {
      fetch(`/api/dictations/${e.dictationId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: DictationRow | null) => { if (d && !d.consumedAt) deliver(d); })
        .catch(() => {});
    } else if (e.status === "failed") {
      setPendingIds((ids) => ids.filter((x) => x !== e.dictationId));
      setError("Transcription échouée — voir la page Dictées.");
    } else if (e.status === "deleted") {
      setPendingIds((ids) => ids.filter((x) => x !== e.dictationId));
    }
  });

  // Plafond des 3 min : le recorder s'arrête seul — venir chercher le blob,
  // sinon la dictée est perdue en silence (même mécanique que l'ancien popover).
  const wasRecording = useRef(false);
  useEffect(() => {
    const was = wasRecording.current;
    wasRecording.current = recording;
    if (!was || recording) return;
    stop().then((r) => { if (r) send(r.blob, r.mime); }).catch(() => {});
  }, [recording, stop, send]);

  const toggle = useCallback(async () => {
    setError(null);
    if (recording) {
      const r = await stop();
      if (r) await send(r.blob, r.mime);
    } else {
      try { await start(); } catch { setError("Micro refusé par le navigateur."); }
    }
  }, [recording, start, stop, send]);

  return { supported, recording, pending: pendingIds.length, error, toggle };
}
