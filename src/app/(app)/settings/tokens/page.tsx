"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    if (res.ok) {
      const { token } = await res.json();
      setFreshToken(token); setLabel(""); load();
    }
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
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Tokens MCP</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <form onSubmit={create} className="flex gap-2">
        <Input placeholder="label (ex: claude-macbook)" value={label}
          onChange={(e) => setLabel(e.target.value)} required />
        <Button type="submit">Créer</Button>
      </form>
      {freshToken && (
        <div className="rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm">
          <p className="font-medium">Token créé — il ne sera plus jamais affiché :</p>
          <code className="block break-all py-2">{freshToken}</code>
          <p className="text-muted-foreground">
            claude mcp add --transport http content-studio
            http://localhost:3003/api/mcp --header &quot;Authorization: Bearer {freshToken}&quot;
          </p>
        </div>
      )}
      <ul className="space-y-2">
        {rows.map((t) => (
          <li key={t.id}
            className="flex items-center justify-between rounded-lg border p-3 text-sm">
            <span>
              {t.label} <code className="text-muted-foreground">{t.prefix}…</code>
              {t.revokedAt && <span className="ml-2 text-red-600">révoqué</span>}
            </span>
            {!t.revokedAt && (
              <Button variant="outline" size="sm" onClick={() => revoke(t.id)}>
                Révoquer
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
