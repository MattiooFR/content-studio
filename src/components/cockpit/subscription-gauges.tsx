"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GaugeBar, type GaugeSegment } from "@/components/cockpit/gauge-bar";
import { Tile } from "@/components/cockpit/tile";
import type { GaugeAccount, GaugePayload } from "@/lib/gauges";

type GaugeSourceRow = {
  id: string;
  name: string;
  kind: "quota" | "cost";
  enabled: boolean;
  lastPayload: GaugePayload;
  lastError: string | null;
};

type GaugesState = {
  sources: GaugeSourceRow[];
  totalCostEur: number;
};

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, n));
}

// resetAt est une chaîne libre (contrat W8) : parse défensif, jamais de throw
// sur une Date invalide — dans ce cas on n'affiche simplement pas de reset.
function parseResetDate(resetAt: string | null | undefined): Date | null {
  if (!resetAt) return null;
  const d = new Date(resetAt);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatReset(d: Date): string {
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

// Le reset affiché = le plus PROCHE (la date la plus tôt) parmi les comptes —
// c'est celui qui contraint en premier.
function earliestReset(accounts: GaugeAccount[]): string | undefined {
  const dates = accounts
    .map((a) => parseResetDate(a.resetAt))
    .filter((d): d is Date => d !== null);
  if (dates.length === 0) return undefined;
  const min = dates.reduce((a, b) => (b < a ? b : a));
  return formatReset(min);
}

// Le serveur borne déjà costMonthlyEur mais un total agrégé peut malgré tout
// diverger (somme de valeurs limites) — un total non fini ou aberrant affiche
// « — » plutôt qu'un nombre qui n'a plus de sens.
function formatCost(totalCostEur: number): string {
  if (!Number.isFinite(totalCostEur) || Math.abs(totalCostEur) > 1e9) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(
    totalCostEur
  );
}

// Jauge grise de repli : une source en lastError ne doit jamais faire
// disparaître son libellé ni, a fortiori, planter le header. Le détail de
// l'erreur vit dans le tooltip (title), jamais affiché en clair dans le
// header (bruit visuel + pas la place).
function ErrorGauge({ label, error }: { label: string; error: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2" title={error}>
      <span className="max-w-24 shrink-0 truncate text-[10px] font-medium tracking-widest text-muted uppercase">
        {label}
      </span>
      <div className="h-1 min-w-16 flex-1 rounded-full bg-raised" aria-hidden />
      <span className="shrink-0 text-[11px] font-semibold text-faint tabular-nums">—</span>
    </div>
  );
}

/**
 * Zone jauges du header (contrat W1 : montée dans la place laissée par
 * `app/(app)/layout.tsx`). Une GaugeBar par source quota + une Tile coût à
 * droite. Auto-refresh au montage puis toutes les 5 min ; un bouton discret
 * force `?refresh=1`. Ne lève JAMAIS : une source cassée devient une jauge
 * grise, un fetch qui échoue laisse l'état précédent affiché.
 */
export function SubscriptionGauges() {
  const [state, setState] = useState<GaugesState | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async (refresh: boolean) => {
    try {
      const res = await fetch(`/api/gauges${refresh ? "?refresh=1" : ""}`);
      if (!res.ok) return;
      const data = (await res.json()) as GaugesState;
      if (mountedRef.current) setState(data);
    } catch {
      // Réseau down, session expirée… le header reste tel quel plutôt que
      // de planter ou d'afficher une erreur intrusive.
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load(false);
    const interval = setInterval(() => load(false), REFRESH_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [load]);

  const sources = state?.sources ?? [];
  const quotaSources = sources.filter((s) => s.kind === "quota" && s.enabled);
  const costSourcesEnabled = sources.filter((s) => s.kind === "cost" && s.enabled);
  const totalCostEur = state?.totalCostEur ?? 0;

  return (
    <div className="hidden min-w-0 flex-1 items-center gap-6 md:flex">
      {/* Rangée des jauges quota : chaque source a une largeur fixe (elle ne
          doit jamais se faire écraser en dessous du contenu de sa barre —
          c'est ce qui produisait un chevauchement de texte avec 2+ sources).
          Si trop de sources pour la largeur dispo, ça scrolle ICI, sans
          jamais pousser la tuile coût ni le bouton hors champ. */}
      <div className="flex min-w-0 flex-1 items-center gap-6 overflow-x-auto">
        {quotaSources.map((s) => {
          if (s.lastError) {
            return <ErrorGauge key={s.id} label={s.name} error={s.lastError} />;
          }
          const accounts = s.lastPayload.accounts ?? [];
          if (accounts.length === 0) return null; // pas encore de données exploitables
          const segments: GaugeSegment[] = accounts.map((a) => ({
            id: a.id,
            percent: clampPercent(a.usedPercent ?? 0),
            available: a.available ?? true,
          }));
          return (
            <GaugeBar
              key={s.id}
              className="shrink-0"
              label={s.name}
              segments={segments}
              reset={earliestReset(accounts)}
            />
          );
        })}
      </div>

      <Tile
        compact
        className="ml-auto shrink-0"
        label="Coût / mois"
        value={costSourcesEnabled.length === 0 ? "—" : formatCost(totalCostEur)}
        hint={
          costSourcesEnabled.length === 0 ? (
            <a href="/settings/gauges" className="text-accent hover:underline">
              configurer
            </a>
          ) : undefined
        }
      />

      <button
        type="button"
        onClick={() => load(true)}
        aria-label="Rafraîchir les jauges"
        title="Rafraîchir les jauges"
        className="shrink-0 text-sm text-faint transition-colors duration-150 hover:text-ink"
      >
        ↻
      </button>
    </div>
  );
}
