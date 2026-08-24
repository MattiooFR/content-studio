"use client";
import { useEffect, useState } from "react";

// Seuil du shell responsive (spec §8) : à partir de `lg` (1024px, même valeur
// que le breakpoint Tailwind), la vue liste garde un volet détail inline ; en
// dessous, le même `DetailHost` bascule en tiroir. Un seul montage possible
// (cf. detail-host.tsx) — piloter `mode` par CSS obligerait à en rendre deux.
const QUERY = "(min-width: 1024px)";

/**
 * Vrai si le viewport est ≥ `lg`. Initialisé à `true` INCONDITIONNELLEMENT
 * (pas de lecture de `matchMedia` dans l'initialiseur) : le rendu d'hydration
 * côté client doit reproduire EXACTEMENT le HTML déjà généré par le serveur
 * (qui n'a pas de `window`, donc pas de vraie valeur) — lire la vraie valeur
 * dès ce premier rendu ferait diverger l'arbre client de l'arbre serveur sur
 * un viewport `< lg` et déclencherait un échec d'hydration React. La vraie
 * valeur n'arrive qu'au montage, via l'effet ci-dessous (flash d'un tick,
 * assumé) puis à chaque changement de largeur via l'abonnement `change`.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(true);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    setIsDesktop(mql.matches);
    function onChange(e: MediaQueryListEvent) {
      setIsDesktop(e.matches);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isDesktop;
}
