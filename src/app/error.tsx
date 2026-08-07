"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary racine (segment `app/`, au-dessus de `(app)` et `(auth)`).
 * C'est CELUI-CI — pas `(app)/error.tsx` — qui rattrape un throw survenant
 * dans `(app)/layout.tsx` lui-même (ex: un composant monté directement dans
 * le header, comme `SubscriptionGauges`) : un error.tsx ne rattrape jamais
 * les erreurs du layout de SON PROPRE segment, seulement celles des enfants
 * (next.js — la frontière est rendue À L'INTÉRIEUR du layout, pas autour).
 * Filet de dernier recours : jamais de page blanche, dans tous les cas.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6 text-center">
        <h1 className="text-base font-semibold text-ink">Une erreur est survenue</h1>
        <p className="text-sm text-muted">
          Quelque chose s&apos;est mal passé pendant l&apos;affichage de cette page. Réessaie
          — si ça persiste, l&apos;info est dans les logs serveur.
        </p>
        <Button onClick={() => reset()}>Réessayer</Button>
      </div>
    </div>
  );
}
