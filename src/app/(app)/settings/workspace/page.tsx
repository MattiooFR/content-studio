"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/cockpit/section-card";

export default function WorkspaceSettingsPage() {
  const [laneCommand, setLaneCommand] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/workspace");
    if (res.ok) {
      const data = (await res.json()) as { laneCommand: string };
      setLaneCommand(data.laneCommand);
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ laneCommand }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Échec de l'enregistrement. Réessaie.");
        return;
      }
      setSaved(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Lanes</h1>
        <p className="mt-1 text-xs text-muted">
          La commande CLI utilisée pour chaque tour de conversation dans le drawer de chat.
        </p>
      </div>

      <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        Cette commande tourne sur TA machine — le serveur ne fait que l&apos;orchestrer (aucun
        appel de modèle depuis l&apos;app, aucune clé de provider stockée ici). Le message de
        chaque tour lui arrive en dernier argument positionnel.
      </p>

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && !error && <p className="text-sm text-success">Enregistré.</p>}

      <SectionCard title="Commande CLI">
        {!loaded ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : (
          <form onSubmit={save} className="space-y-3">
            <Textarea
              value={laneCommand}
              onChange={(e) => {
                setLaneCommand(e.target.value);
                setSaved(false);
              }}
              placeholder="claude -p --output-format stream-json --verbose"
              className="font-mono text-xs"
              spellCheck={false}
            />
            <p className="text-xs text-faint">
              Ex. <code className="font-mono">claude -p --output-format stream-json --verbose</code> ou{" "}
              <code className="font-mono">codex exec --json</code>. Reprise de conversation via{" "}
              <code className="font-mono">--resume</code> quand le CLI le supporte.
            </p>
            <Button type="submit" disabled={submitting || !laneCommand.trim()}>
              {submitting ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </form>
        )}
      </SectionCard>
    </div>
  );
}
