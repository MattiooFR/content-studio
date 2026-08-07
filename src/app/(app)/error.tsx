"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Error boundary du groupe `(app)` — rattrape un throw dans une page/segment
 * enfant (ex: `/`, `/ideas/[id]`, `/settings/gauges`). Ne rattrape PAS un
 * throw dans `(app)/layout.tsx` lui-même (le header, dont `SubscriptionGauges`)
 * — c'est le rôle de `src/app/error.tsx`, un cran au-dessus. Les deux
 * existent pour qu'aucune erreur de rendu ne laisse une page blanche, quel
 * que soit le segment où elle survient.
 */
export default function AppError({
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
    <div className="flex min-h-[60vh] items-center justify-center px-6">
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
