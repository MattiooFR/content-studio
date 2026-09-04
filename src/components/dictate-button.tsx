"use client";
import { Loader2, Mic, Square } from "lucide-react";
import { useDictation } from "@/hooks/use-dictation";
import { cn } from "@/lib/utils";

/**
 * Le micro d'un champ : idle → enregistre, enregistrement → termine et envoie,
 * en attente → compteur. Absent si le navigateur n'a pas de micro (pas de
 * bouton mort).
 */
export function DictateButton({ fieldKey, onText, recover, className }: {
  fieldKey: string; onText: (text: string) => boolean; recover?: boolean; className?: string;
}) {
  const { supported, recording, pending, error, toggle } = useDictation({ fieldKey, onText, recover });
  if (!supported) return null;
  const label = recording ? "Terminer la dictée" : pending ? `${pending} transcription(s) en cours` : "Dicter";
  return (
    <button
      type="button"
      onClick={toggle}
      title={error ?? label}
      aria-label={label}
      aria-pressed={recording}
      className={cn(
        "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-muted transition-colors duration-150 hover:bg-raised hover:text-ink",
        recording && "text-danger animate-pulse",
        error && "text-danger",
        className,
      )}
    >
      {recording ? (
        <Square className="size-3.5" aria-hidden />
      ) : pending ? (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          <span className="text-[10px] tabular-nums">{pending}</span>
        </>
      ) : (
        <Mic className="size-4" aria-hidden />
      )}
    </button>
  );
}
