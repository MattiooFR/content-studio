"use client";
import { useEffect, useState } from "react";

// Seuil du shell responsive (spec §8) : à partir de `lg` (1024px, même valeur
// que le breakpoint Tailwind), la vue liste garde un volet détail inline ; en
// dessous, le même `DetailHost` bascule en tiroir. Un seul montage possible
// (cf. detail-host.tsx) — piloter `mode` par CSS obligerait à en rendre deux.
const QUERY = "(min-width: 1024px)";

/**
 * Vrai si le viewport est ≥ `lg`. Défaut `true` côté serveur (pas de
 * `window`) : la majorité des sessions sont un poste de pilotage desktop, et
 * ce défaut évite un flash « tiroir » au premier rendu pour elles. Un client
 * mobile corrige la valeur dès son premier rendu (l'initialiseur lit
 * `matchMedia` directement, `window` existe déjà) puis à chaque changement de
 * largeur via l'abonnement posé en effet.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === "undefined" ? true : window.matchMedia(QUERY).matches
  );

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
