"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/cockpit/section-card";

type TokenRow = {
  id: string; label: string; prefix: string;
  lastUsedAt: string | null; revokedAt: string | null;
};

export default function TokensPage() {
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [label, setLabel] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/tokens");
    if (res.ok) setRows(await res.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    if (!res.ok) {
      setError("Échec de la création du token. Réessaie.");
      return;
    }
    setError(null);
    const { token } = await res.json();
    setFreshToken(token); setLabel(""); load();
  }

  async function revoke(id: string) {
    const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setError(
        "Échec de la révocation — le token reste actif. Réessaie."
      );
      return;
    }
    setError(null);
    load();
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Tokens MCP</h1>
        <p className="mt-1 text-xs text-muted">
          Chaque agent reçoit son propre token — révocable sans toucher aux autres.
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <SectionCard title="Nouveau token">
        <form onSubmit={create} className="flex gap-2">
          <Input placeholder="label (ex: claude-macbook)" value={label}
            onChange={(e) => setLabel(e.target.value)} required />
          <Button type="submit">Créer</Button>
        </form>
      </SectionCard>

      {freshToken && (
        <div className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft p-4 text-sm">
          <p className="font-medium">Token créé — il ne sera plus jamais affiché :</p>
          <code className="block rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs break-all">
            {freshToken}
          </code>
          <p className="font-mono text-xs leading-relaxed text-muted">
            claude mcp add --transport http content-studio
            http://localhost:3003/api/mcp --header &quot;Authorization: Bearer {freshToken}&quot;
          </p>
        </div>
      )}

      <SectionCard
        title="Tokens"
        badge={<span className="text-[11px] text-faint tabular-nums">{rows.length}</span>}
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted">Aucun token pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((t) => (
              <li key={t.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-line bg-raised/40 p-3 text-sm">
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{t.label}</span>
                  <code className="font-mono text-xs text-muted">{t.prefix}…</code>
                  {t.revokedAt ? (
                    <span className="text-[10px] font-medium tracking-widest text-danger uppercase">
                      révoqué
                    </span>
                  ) : (
                    <span className="text-[11px] text-faint tabular-nums">
                      {t.lastUsedAt
                        ? `dernier usage ${new Date(t.lastUsedAt).toLocaleDateString("fr-FR")}`
                        : "jamais utilisé"}
                    </span>
                  )}
                </span>
                {!t.revokedAt && (
                  <Button variant="outline" size="sm" onClick={() => revoke(t.id)}>
                    Révoquer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
