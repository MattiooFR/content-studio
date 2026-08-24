"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";
import { StatusBadge } from "@/components/cockpit/status-badge";

type GaugeKind = "quota" | "cost";

type GaugeSourceRow = {
  id: string;
  name: string;
  url: string;
  kind: GaugeKind;
  enabled: boolean;
  lastError: string | null;
  lastFetchedAt: string | null;
};

export default function GaugesSettingsPage() {
  const [rows, setRows] = useState<GaugeSourceRow[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<GaugeKind>("quota");
  const [headersText, setHeadersText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/gauges");
    if (res.ok) {
      const data = (await res.json()) as { sources: GaugeSourceRow[] };
      setRows(data.sources);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Parse et valide le JSON des headers AVANT tout appel réseau — un JSON
    // cassé ne doit jamais partir en POST pour échouer côté serveur.
    let headers: Record<string, string> | undefined;
    if (headersText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(headersText);
      } catch {
        setError("Headers : JSON invalide — vérifie la syntaxe avant d'enregistrer.");
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError('Headers : un objet à plat attendu, ex. {"x-api-key": "..."}');
        return;
      }
      headers = parsed as Record<string, string>;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/gauges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, url, kind, headers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Échec de la création de la source. Réessaie.");
        return;
      }
      setName("");
      setUrl("");
      setKind("quota");
      setHeadersText("");
      await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    const res = await fetch(`/api/gauges/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      setError("Échec de la mise à jour — l'état n'a pas changé. Réessaie.");
      return;
    }
    setError(null);
    load();
  }

  async function remove(id: string) {
    const res = await fetch(`/api/gauges/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Échec de la suppression — la source reste active. Réessaie.");
      return;
    }
    setError(null);
    load();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Jauges</h1>
        <p className="mt-1 text-xs text-muted">
          Chaque source interroge un endpoint que tu contrôles — le cockpit ne connaît aucun
          provider.
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <SectionCard title="Nouvelle source">
        <form onSubmit={create} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Input
              placeholder="nom (ex: Bridge Claude)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as GaugeKind)}
              className="h-8 rounded-lg border border-line bg-transparent px-2.5 text-sm text-ink outline-none focus-visible:border-accent"
            >
              <option value="quota">Quota (comptes)</option>
              <option value="cost">Coût mensuel</option>
            </select>
          </div>
          <Input
            placeholder="https://…/health"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <Textarea
            placeholder={'headers JSON optionnel — ex: {"x-api-key": "..."}'}
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            className="font-mono text-xs"
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Création…" : "Ajouter"}
          </Button>
        </form>
      </SectionCard>

      <SectionCard
        title="Sources"
        badge={<span className="text-[11px] text-faint tabular-nums">{rows.length}</span>}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Aucune source pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-sm"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{s.name}</span>
                  <code className="max-w-64 truncate font-mono text-xs text-muted">{s.url}</code>
                  <StatusBadge kind="gauge" value={s.kind} />
                  <StatusBadge kind="gauge" value={s.enabled ? "enabled" : "disabled"} />
                  {s.lastError ? (
                    <span title={s.lastError}>
                      <StatusBadge kind="gauge" value="error" />
                    </span>
                  ) : s.lastFetchedAt ? (
                    <span className="text-[11px] text-faint tabular-nums">
                      dernier ok {new Date(s.lastFetchedAt).toLocaleString("fr-FR")}
                    </span>
                  ) : (
                    <span className="text-[11px] text-faint">jamais interrogée</span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => toggle(s.id, !s.enabled)}>
                    {s.enabled ? "Désactiver" : "Activer"}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(s.id)}>
                    Supprimer
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
