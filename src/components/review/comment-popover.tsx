"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useRecorder } from "@/hooks/use-recorder";
import type { CommentRow } from "@/components/review/use-comments";

/**
 * La bulle de commentaire : texte libre + dictée, posée au-dessus du corps en
 * lecture. Cmd/Ctrl+Entrée enregistre, Échap ferme.
 */
export function CommentPopover({ existing, onSaveText, onSaveVoice, onResolve, onDelete, onClose, style }: {
  existing: CommentRow | null;
  onSaveText: (body: string) => Promise<void>;
  onSaveVoice: (blob: Blob, mime: string) => Promise<void>;
  onResolve?: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
  style: React.CSSProperties;
}) {
  const [text, setText] = useState(existing?.body ?? "");
  const { supported, recording, start, stop } = useRecorder();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => { setText(existing?.body ?? ""); }, [existing?.body]);

  // Plafond des 3 min : le recorder s'arrête tout seul et personne n'attend
  // son `stop()`. On vient donc chercher le blob ici, sinon la dictée est
  // perdue en silence. `stop()` étant one-shot côté hook, si c'est le clic
  // « Terminer » qui a arrêté, cet effet reçoit null et n'envoie rien.
  const wasRecording = useRef(false);
  useEffect(() => {
    const was = wasRecording.current;
    wasRecording.current = recording;
    if (!was || recording) return;
    stop().then((r) => { if (r) onSaveVoice(r.blob, r.mime); }).catch(() => { /* rien à faire */ });
  }, [recording, stop, onSaveVoice]);

  async function dicter() {
    if (recording) {
      const r = await stop();
      if (r) await onSaveVoice(r.blob, r.mime);
    } else {
      try { await start(); } catch { /* micro refusé : rien à faire, le bouton reste */ }
    }
  }

  return (
    <div style={style} className="absolute z-20 w-80 rounded-xl border border-line bg-surface p-3 shadow-lg"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) {
          // sans ça, le raccourci insère AUSSI un saut de ligne dans le
          // textarea avant que le popover ne se ferme
          e.preventDefault();
          onSaveText(text.trim());
        }
      }}>
      {existing?.transcription === "pending" && (
        <p className="mb-2 text-xs text-muted animate-pulse">Transcription en cours…</p>
      )}
      {existing?.transcription === "failed" && (
        <p className="mb-2 text-xs text-danger">Transcription échouée — écris la remarque à la main.</p>
      )}
      <Textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)}
        placeholder={existing ? "Modifier la remarque…" : "Ta remarque (Cmd+Entrée pour enregistrer)"} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => text.trim() && onSaveText(text.trim())} disabled={!text.trim()}>
          Enregistrer
        </Button>
        {supported && !existing && (
          <Button size="sm" variant="outline" onClick={dicter}>
            {recording ? "■ Terminer la dictée" : "🎙️ Dicter"}
          </Button>
        )}
        {existing && onResolve && <Button size="sm" variant="outline" onClick={onResolve}>Résoudre</Button>}
        {existing && onDelete && <Button size="sm" variant="outline" onClick={onDelete}>Supprimer</Button>}
        <Button size="sm" variant="outline" onClick={onClose}>Fermer</Button>
      </div>
    </div>
  );
}
