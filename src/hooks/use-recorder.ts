"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type Recording = { blob: Blob; mime: string };

// Ordre de préférence : opus dans webm (Chrome/Firefox), sinon mp4 (Safari),
// sinon ogg. `undefined` = on laisse le navigateur choisir. Tous ces types
// sont acceptés par la route audio (AUDIO_MIMES, src/lib/audio.ts), qui
// compare sur le type sans paramètres (`audio/webm;codecs=opus` → `audio/webm`).
const CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
export const MAX_RECORD_MS = 3 * 60_000;

/**
 * Dictée d'un commentaire : un `MediaRecorder`, un plafond dur de 3 min,
 * et le blob rendu par `stop()`.
 *
 * Le résultat de l'enregistrement en cours vit dans `pending` — une promesse
 * résolue par `onstop`, QUELLE QUE SOIT la cause de l'arrêt (clic « Terminer »
 * ou plafond des 3 min). Sans ça, l'arrêt automatique perd la dictée en
 * silence : personne n'attend la promesse créée par le timer, et un `stop()`
 * ultérieur ne trouve plus de recorder.
 *
 * `stop()` est one-shot : il consomme `pending` (remis à null). Le popover
 * appelle donc `stop()` deux fois sans risque — une fois au clic, une fois
 * depuis l'effet « arrêt automatique » — sans jamais envoyer deux fois le
 * même blob.
 */
export function useRecorder() {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<BlobPart[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Promise<Recording | null> | null>(null);
  const [recording, setRecording] = useState(false);
  const supported =
    typeof window !== "undefined" && !!navigator.mediaDevices && typeof MediaRecorder !== "undefined";

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const start = useCallback(async () => {
    if (rec.current) return; // déjà en cours : pas de second flux micro
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    chunks.current = [];
    rec.current = r;
    pending.current = new Promise<Recording | null>((resolve) => {
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        const mime = r.mimeType || preferred || "audio/webm";
        const blob = new Blob(chunks.current, { type: mime });
        r.stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
        chunks.current = [];
        clearTimer();
        setRecording(false);
        // blob vide = rien à envoyer (la route répond 400 « audio vide »)
        resolve(blob.size ? { blob, mime } : null);
      };
    });
    r.start(250);
    setRecording(true);
    timer.current = setTimeout(() => {
      if (rec.current && rec.current.state !== "inactive") rec.current.stop();
    }, MAX_RECORD_MS);
  }, []);

  const stop = useCallback((): Promise<Recording | null> => {
    const p = pending.current;
    pending.current = null; // one-shot : un second appel rendra null
    const r = rec.current;
    if (r && r.state !== "inactive") r.stop();
    clearTimer();
    return p ?? Promise.resolve(null);
  }, []);

  // Démontage pendant une dictée (popover fermé, onglet changé) : couper le
  // micro. Sinon le flux tourne et le voyant du navigateur reste allumé.
  useEffect(() => () => {
    const r = rec.current;
    if (r && r.state !== "inactive") r.stop();
    r?.stream.getTracks().forEach((t) => t.stop());
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { supported, recording, start, stop };
}
