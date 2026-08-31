"use client";
import { useCallback, useEffect, useState } from "react";
import { SectionCard } from "@/components/cockpit/section-card";
import { WatchCard, type WatchItemDTO } from "@/components/watch/watch-card";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";

export default function WatchPage() {
  const [proposed, setProposed] = useState<WatchItemDTO[]>([]);
  const [validated, setValidated] = useState<WatchItemDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const [proposedRes, validatedRes] = await Promise.all([
      fetch("/api/watch/items?status=proposed"),
      fetch("/api/watch/items?status=validated&limit=10"),
    ]);
    if (proposedRes.ok) {
      const data = (await proposedRes.json()) as { items: WatchItemDTO[] };
      setProposed(data.items);
    }
    if (validatedRes.ok) {
      const data = (await validatedRes.json()) as { items: WatchItemDTO[] };
      setValidated(data.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Un dépôt du worker, une décision d'un autre onglet, ou un job de
  // publication qui aboutit : dans les trois cas la file affichée peut être
  // périmée — on la recharge. Pas besoin de useCallback ici : le hook garde
  // juste une ref à jour du handler et n'ouvre la connexion SSE qu'une fois
  // (voir use-workspace-events.ts), qu'importe que cette fonction soit
  // recréée à chaque rendu.
  useWorkspaceEvents((e) => {
    if (e.type === "watch.updated" || e.type === "job.updated") load();
  });

  function setBusy(id: string, v: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setError(id: string, msg: string | null) {
    setErrors((prev) => {
      if (msg == null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: msg };
    });
  }

  async function runAction(id: string, body: Record<string, unknown>, fallback: string) {
    setBusy(id, true);
    setError(id, null);
    try {
      const res = await fetch(`/api/watch/items/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        setError(id, payload?.error ?? fallback);
        return;
      }
      await load();
    } finally {
      setBusy(id, false);
    }
  }

  function handleValidate(id: string, editedText: string | undefined) {
    runAction(id, { action: "validate", edited_text: editedText }, "Échec de la validation. Réessaie.");
  }

  function handleRefuse(id: string, reason: string | undefined, note: string | undefined) {
    runAction(id, { action: "refuse", reason, note }, "Échec du refus. Réessaie.");
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Veille — propositions du matin</h1>
        <p className="mt-1 text-xs text-muted">
          Le worker dépose ses propositions chaque matin. À toi de valider ou de refuser.
        </p>
      </div>

      <SectionCard
        title="En attente"
        badge={<span className="text-[11px] text-faint tabular-nums">{proposed.length}</span>}
      >
        {loading ? (
          <p className="text-sm text-muted">Chargement…</p>
        ) : proposed.length === 0 ? (
          <p className="text-sm text-muted">
            Aucune proposition en attente — le worker dépose chaque matin.
          </p>
        ) : (
          <ul className="space-y-4">
            {proposed.map((item) => (
              <li key={item.id}>
                <WatchCard
                  item={item}
                  busy={busyIds.has(item.id)}
                  error={errors[item.id] ?? null}
                  onValidate={handleValidate}
                  onRefuse={handleRefuse}
                />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Validées récemment">
        {validated.length === 0 ? (
          <p className="text-sm text-muted">Aucune validation récente.</p>
        ) : (
          <ul className="space-y-2">
            {validated.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-raised/40 p-3 text-sm"
              >
                <span className="min-w-0 truncate text-ink">{item.textAdapted ?? item.textSource}</span>
                {item.publicationUrl ? (
                  <a
                    href={item.publicationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-accent hover:underline"
                  >
                    Voir la publication
                  </a>
                ) : (
                  <span className="shrink-0 text-[11px] text-faint">pas encore publiée</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
