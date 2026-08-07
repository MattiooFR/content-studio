"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type FunnelRow = {
  channelKey: string;
  channelName: string;
  ideas: number;
  drafts: number;
  inReview: number;
  approved: number;
  published: number;
  rejected: number;
  bottleneck: string | null;
};

/**
 * Une ligne de pipeline par canal : nom, puis flux (idées → drafts → review →
 * approuvés → publiés · rejetés) en tabular-nums. Segments muted, published
 * en success, rejected en danger, approved en accent. Dessous : "aucun goulot"
 * (success + point coloré CSS) ou alerte de goulot (warning). Skeleton pendant
 * le fetch, erreur visible. Les canaux à zéro s'affichent quand même.
 */
export function FunnelLine() {
  const [rows, setRows] = useState<FunnelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/stats/funnel");
        if (!res.ok) {
          setError(`Erreur ${res.status}`);
          return;
        }
        const data = (await res.json()) as FunnelRow[];
        setRows(data);
        setError(null);
      } catch (e) {
        setError("Impossible de charger le pipeline");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-4 w-1/4 bg-raised animate-pulse rounded" />
            <div className="h-3 w-full bg-raised animate-pulse rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.channelKey} className="space-y-1.5">
          {/* Titre du canal + flux */}
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink">{row.channelName}</span>
            <div className="text-sm text-muted tabular-nums">
              {/* Idées → Drafts → Review → Approuvés → Publiés · Rejetés */}
              <span>{row.ideas}</span>
              <span className="mx-1">idées</span>
              <span className="mx-1 text-faint">→</span>
              <span>{row.drafts}</span>
              <span className="mx-1">brouillons</span>
              <span className="mx-1 text-faint">→</span>
              <span>{row.inReview}</span>
              <span className="mx-1">en review</span>
              <span className="mx-1 text-faint">→</span>
              <span className="text-accent">{row.approved}</span>
              <span className="mx-1 text-accent">approuvé{row.approved > 1 ? "s" : ""}</span>
              <span className="mx-1 text-faint">→</span>
              <span className="text-success">{row.published}</span>
              <span className="mx-1 text-success">publié{row.published > 1 ? "s" : ""}</span>
              <span className="mx-1 text-faint">·</span>
              <span className="text-danger">{row.rejected}</span>
              <span className="mx-1 text-danger">rejeté{row.rejected > 1 ? "s" : ""}</span>
            </div>
          </div>

          {/* Goulot (ou absence de goulot) */}
          <div className="text-xs leading-relaxed">
            {row.bottleneck ? (
              <div className="flex items-start gap-2 text-warning">
                <span className="mt-1.5 inline-block size-1.5 rounded-full bg-warning shrink-0" />
                <span>{row.bottleneck}</span>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-success">
                <span className="mt-1.5 inline-block size-1.5 rounded-full bg-success shrink-0" />
                <span>aucun goulot</span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
