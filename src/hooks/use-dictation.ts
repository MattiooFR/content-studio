"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecorder } from "@/hooks/use-recorder";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type DictationRow = {
  id: string; status: "pending" | "done" | "failed"; text: string;
  fieldKey: string; consumedAt: string | null; error: string | null;
};
// Réponse de /api/dictations/[id]/consume : la ligne + `first` (revue finale,
// I1) — indique si CET appel a posé consumedAt (claim-first).
type ConsumeResponse = DictationRow & { first: boolean };

/**
 * Dictée asynchrone d'un champ : enregistre, poste l'audio, puis livre le
 * texte à `onText` quand le worker a fini (SSE) — même si l'utilisateur a
 * continué à travailler entre-temps. `recover` = au montage, reprendre ce que
 * ce fieldKey attendait (reload pendant une transcription).
 *
 * `onText` rend un booléen : `true` si le texte a bien été inséré quelque
 * part (élément monté), `false` sinon (revue finale, M4) — dans ce cas la
 * dictée n'est pas marquée « livrée » localement, la page Dictées reste la
 * source de vérité pour la récupérer.
 */
export function useDictation({ fieldKey, onText, recover = true }: {
  fieldKey: string; onText: (text: string) => boolean; recover?: boolean;
}) {
  const { supported, recording, start, stop } = useRecorder();
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const delivered = useRef(new Set<string>());

  // Réfs lues par le cleanup de démontage (I3, plus bas) : toujours à jour,
  // y compris juste avant le démontage qui déclenche ce cleanup.
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const fieldKeyRef = useRef(fieldKey);
  fieldKeyRef.current = fieldKey;

  const deliver = useCallback(async (d: DictationRow) => {
    if (delivered.current.has(d.id)) return; // déjà livrée : un événement en double ne réinsère pas
    // Claim-first (revue finale, I1) : on réclame la dictée AVANT d'insérer.
    // Si un autre appel (autre carte partageant la même clé, double
    // invocation d'un même événement) a déjà réclamé, `first` est false ici
    // — on ne touche pas au champ, on se contente de retirer l'id du compteur.
    const res: ConsumeResponse | null = await fetch(`/api/dictations/${d.id}/consume`, { method: "POST" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    setPendingIds((ids) => ids.filter((x) => x !== d.id));
    if (!res || res.first !== true) return;
    const inserted = onTextRef.current(d.text);
    // Marquée « livrée » seulement si vraiment insérée (M4) — sinon la dictée
    // reste consommée côté serveur (on l'a réclamée) mais son texte n'a été
    // déposé nulle part : la page Dictées reste le recours pour le récupérer.
    if (inserted) delivered.current.add(d.id);
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
      // Retrait inconditionnel (M4) : sinon le compteur reste périmé quand le
      // fetch échoue, ou quand la dictée est déjà consommée (autre instance).
      setPendingIds((ids) => ids.filter((x) => x !== e.dictationId));
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

  // I3 — enregistrement en cours au démontage (Échap du popover, Annuler du
  // formulaire, fermeture du chat, remontage) : `useRecorder` coupe le micro
  // dans SON propre cleanup et jetterait le blob capturé jusque-là. Cet effet
  // est déclaré APRÈS l'appel à useRecorder() ci-dessus, donc son cleanup
  // s'exécute APRÈS celui de useRecorder (React nettoie les effets d'un
  // composant dans leur ordre d'enregistrement) : au moment où on appelle
  // `stop()` ici, le MediaRecorder est déjà passé à "inactive" (stop() est
  // synchrone sur ce point), mais l'événement asynchrone `onstop` — qui
  // résout la promesse `pending` de useRecorder avec le blob — n'a pas
  // encore eu lieu, et rien dans le cleanup de useRecorder ne touche à cette
  // promesse. `stop()` la rend donc encore intacte ici, et elle se résout un
  // instant plus tard avec le blob capturé jusqu'à l'arrêt : pas besoin d'un
  // ref+onstop alternatif pour capter le blob autrement.
  useEffect(() => () => {
    if (!recordingRef.current) return;
    stopRef.current()
      .then((r) => {
        if (!r) return;
        fetch(`/api/dictations?field_key=${encodeURIComponent(fieldKeyRef.current)}`, {
          method: "POST", headers: { "content-type": r.mime }, body: r.blob, keepalive: true,
        }).catch(() => { /* best-effort : keepalive survit à la fermeture d'onglet, pas au réseau coupé */ });
      })
      .catch(() => {});
  }, []);

  return { supported, recording, pending: pendingIds.length, error, toggle };
}
