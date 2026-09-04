"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

type Dictation = {
  id: string; status: "pending" | "done" | "failed"; text: string; error: string | null;
  fieldKey: string; consumedAt: string | null; createdAt: string;
};

/** Le tiroir : tout ce qui a été dicté, en attente / prêt / en échec — rien ne se perd. */
export default function DictationsPage() {
  const [rows, setRows] = useState<Dictation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/dictations?limit=50");
    if (res.ok) setRows(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);
  useWorkspaceEvents((e) => { if (e.type === "dictation.updated") load(); });

  async function act(id: string, action: "retry" | "delete") {
    setError(null);
    const res = action === "retry"
      ? await fetch(`/api/dictations/${id}/retry`, { method: "POST" })
      : await fetch(`/api/dictations/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const { error: message } = await res.json().catch(() => ({ error: null }));
      setError(message ?? "Action impossible.");
    }
    load();
  }

  async function copy(d: Dictation) {
    setError(null);
    try { await navigator.clipboard.writeText(d.text); setCopied(d.id); setTimeout(() => setCopied(null), 1500); }
    catch { setError("Presse-papiers indisponible."); }
  }

  const pending = rows.filter((d) => d.status === "pending").length;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight">Dictées</h1>
        <span className="text-[11px] text-faint tabular-nums">{pending} en cours</span>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <SectionCard title="Les 50 dernières">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Aucune dictée — le micro à droite de chaque champ envoie ici.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((d) => (
              <li key={d.id} className="rounded-lg border border-line bg-raised/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-faint">{d.fieldKey || "champ inconnu"}</span>
                  {d.consumedAt && <span className="text-[10px] tracking-widest text-faint uppercase">insérée</span>}
                  <StatusBadge kind="dictation" value={d.status} className={d.status === "pending" ? "animate-pulse" : undefined} />
                </div>
                {d.status === "done" && (
                  <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{d.text.length > 400 ? `${d.text.slice(0, 400)}…` : d.text}</p>
                )}
                {d.status === "failed" && <p className="mt-2 text-xs text-danger">{d.error ?? "transcription échouée"}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.status === "done" && (
                    <Button size="sm" variant="outline" onClick={() => copy(d)}>{copied === d.id ? "Copié" : "Copier"}</Button>
                  )}
                  {d.status === "failed" && <Button size="sm" variant="outline" onClick={() => act(d.id, "retry")}>Réessayer</Button>}
                  <Button size="sm" variant="destructive" onClick={() => act(d.id, "delete")}>Supprimer</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <p className="text-xs text-faint">
        Le texte d&apos;une dictée s&apos;insère tout seul dans son champ s&apos;il est encore ouvert ; sinon il t&apos;attend ici.
      </p>
    </div>
  );
}
