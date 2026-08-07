"use client";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { ContentEditor, type ContentEditorHandle } from "@/components/editor";
import { ExportButton } from "@/components/export-button";
import { StatusBadge } from "@/components/cockpit/status-badge";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";
import { ProposedBanner } from "@/components/proposed-banner";
import { RevisionsPanel, type Revision } from "@/components/revisions-panel";

type ContentWithChannel = {
  id: string; body: string; status: string; currentRevisionId: string | null;
  channel: { name: string; key: string; constraints: { export_format?: string } };
};

const STATUSES = ["draft", "review", "approved", "published"] as const;

export default function ContentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [content, setContent] = useState<ContentWithChannel | null>(null);
  const [externalBody, setExternalBody] = useState<{ body: string; key: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // note = information non bloquante (ex: diff rafraîchi après un 409) — distincte
  // de `error`, qui reste réservé aux échecs réels d'une action.
  const [note, setNote] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  // révisions écrites PAR CET ONGLET — pour ignorer ses propres événements SSE (Task 12)
  const ownRevisions = useRef<Set<string>>(new Set());
  // handle impératif vers l'éditeur : isEditing() (focus DOM) + flushSaves()
  // (attend l'autosave en vol, y compris le debounce armé) — utilisé par
  // resolve() ci-dessous. Round 3 : la page ne gate plus rien elle-même —
  // le gate/rejeu d'un externalBody pendant l'édition est centralisé dans
  // ContentEditor (voir editor.tsx, `pendingRef`) : moins de logique de
  // focus/timing éparpillée entre deux fichiers, moins de bugs à chaque round.
  const editorRef = useRef<ContentEditorHandle>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contents/${id}`);
    if (res.ok) setContent(await res.json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const loadRevisions = useCallback(async () => {
    const res = await fetch(`/api/contents/${id}/revisions`);
    if (res.ok) setRevisions(await res.json());
  }, [id]);
  useEffect(() => { loadRevisions(); }, [loadRevisions]);

  useWorkspaceEvents((e) => {
    if (e.type !== "content.updated" || e.contentId !== id) return;
    if (ownRevisions.current.has(e.revisionId)) return; // notre propre save (fast-path)
    if (e.state === "current") {
      // écriture devenue courante (agent ou user tiers) → refetch et pousse
      // à l'éditeur, point. Round 3 : la page ne décide plus QUAND appliquer
      // ce corps (focus, blur, stash...) — c'est ContentEditor qui gate en
      // interne si besoin (`pendingRef`) et rejoue au bon moment. La page se
      // contente de fournir la donnée la plus fraîche à chaque event.
      fetch(`/api/contents/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => {
          if (!c) {
            setError("Échec du rafraîchissement du contenu après une mise à jour distante.");
            return;
          }
          setContent(c);
          setExternalBody({ body: c.body, key: Date.now() });
        })
        .catch(() => {
          setError("Échec du rafraîchissement du contenu après une mise à jour distante.");
        });
    }
    loadRevisions(); // dans tous les cas (une proposed apparaît dans la liste)
  });

  async function setStatus(status: string) {
    const res = await fetch(`/api/contents/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setError("Échec du changement de statut. Réessaie.");
      return;
    }
    setError(null);
    load();
  }

  async function resolve(revId: string, action: "accept" | "reject") {
    setError(null);
    setNote(null);

    let expectedCurrentRevisionId = content?.currentRevisionId ?? null;

    if (action === "accept") {
      // Sérialise l'accept derrière tout autosave en vol/enchaîné (file à un
      // slot de la Task 11) : sans ça, un save utilisateur qui commit APRÈS
      // l'accept écrase silencieusement la version acceptée — l'écriture user
      // ne porte aucune garde de fraîcheur côté serveur (décision actée :
      // l'autosave doit rester fluide, la protection est ici, côté client).
      await editorRef.current?.flushSaves();

      let fresh: ContentWithChannel | null;
      try {
        const r = await fetch(`/api/contents/${id}`);
        fresh = r.ok ? await r.json() : null;
      } catch {
        setError("Échec du rechargement du contenu avant résolution. Réessaie.");
        return;
      }
      if (!fresh) {
        setError("Échec du rechargement du contenu avant résolution. Réessaie.");
        return;
      }

      if (fresh.currentRevisionId !== expectedCurrentRevisionId) {
        // le flush (ou une autre écriture arrivée entre-temps) a fait bouger
        // le contenu : ne PAS résoudre avec un expectedCurrentRevisionId
        // périmé — même traitement que le 409 serveur (note, pas erreur),
        // on remonte le diff frais plutôt que d'écraser à l'aveugle.
        setContent(fresh);
        setExternalBody({ body: fresh.body, key: Date.now() });
        setNote("Le contenu a changé entre-temps : diff rafraîchi.");
        loadRevisions();
        return;
      }
      expectedCurrentRevisionId = fresh.currentRevisionId;
    }

    let res: Response;
    try {
      res = await fetch(`/api/contents/${id}/revisions/${revId}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // La révision courante que CE rendu affichait (rafraîchie juste au-dessus
        // pour un accept) : si le contenu a quand même bougé depuis (écriture
        // agent concurrente), le serveur répond 409 et on recharge le diff au
        // lieu d'écraser à l'aveugle — filet serveur, en plus du flush client.
        body: JSON.stringify({ action, expectedCurrentRevisionId }),
      });
    } catch {
      setError("Échec réseau lors de la résolution de la proposition. Réessaie.");
      return;
    }
    if (res.status === 409) {
      // pas une erreur : la proposition était périmée, le serveur n'a rien écrasé.
      setNote("Le contenu a changé entre-temps : diff rafraîchi.");
    } else if (!res.ok) {
      setError("Échec de l'action sur la proposition. Réessaie.");
      return;
    }
    // succès ou 409 : dans les deux cas l'état serveur fait foi, on recharge.
    try {
      const r = await fetch(`/api/contents/${id}`);
      const c = r.ok ? await r.json() : null;
      if (c) {
        setContent(c);
        setExternalBody({ body: c.body, key: Date.now() });
      } else {
        setError("Échec du rechargement du contenu après résolution.");
      }
    } catch {
      setError("Échec du rechargement du contenu après résolution.");
    }
    loadRevisions();
  }

  async function restore(rev: Revision) {
    setError(null);
    setNote(null);
    // Restaurer = créer une NOUVELLE révision courante avec le corps de
    // l'ancienne — via le PATCH existant (authorType "user", même chemin
    // qu'un autosave). Aucun endpoint dédié : le cœur applyContentUpdate
    // fait déjà tout (supersede la current, insère la nouvelle).
    let res: Response;
    try {
      res = await fetch(`/api/contents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: rev.body }),
      });
    } catch {
      setError("Échec réseau lors de la restauration de la révision. Réessaie.");
      return;
    }
    if (!res.ok) {
      setError("Échec de la restauration de la révision. Réessaie.");
      return;
    }
    try {
      const r = await fetch(`/api/contents/${id}`);
      const c = r.ok ? await r.json() : null;
      if (c) {
        setContent(c);
        setExternalBody({ body: c.body, key: Date.now() });
      } else {
        setError("Échec du rechargement du contenu après restauration.");
      }
    } catch {
      setError("Échec du rechargement du contenu après restauration.");
    }
    loadRevisions();
  }

  if (!content) return <p className="text-sm text-muted">Chargement…</p>;

  const proposed = revisions.find((r) => r.state === "proposed");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-lg font-semibold tracking-tight">
            {content.channel.name}
          </h1>
          <StatusBadge kind="content" value={content.status} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-full border border-line bg-raised p-0.5">
            {STATUSES.map((s) => (
              <button key={s} onClick={() => setStatus(s)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wider uppercase transition-colors duration-150 ${
                  s === content.status
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:text-ink"
                }`}>
                {s}
              </button>
            ))}
          </div>
          <ExportButton body={content.body}
            format={content.channel.constraints.export_format ?? "markdown"} />
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {note && <p className="text-sm text-muted">{note}</p>}
      {proposed && (
        <ProposedBanner
          currentBody={content.body}
          proposedBody={proposed.body}
          onResolve={(action) => resolve(proposed.id, action)}
        />
      )}
      <ContentEditor
        ref={editorRef}
        contentId={id}
        initialBody={content.body}
        externalBody={externalBody}
        onSaved={(revisionId, body) => {
          ownRevisions.current.add(revisionId);
          // Sans ceci, content.currentRevisionId/body restaient figés sur la
          // révision PRÉCÉDENTE jusqu'au prochain refetch externe (le fast-path
          // SSE ci-dessus ignore cette révision, donc rien ne rafraîchissait
          // l'état) : le bandeau de proposition diffait contre un corps périmé,
          // et resolve() capturait un expectedCurrentRevisionId périmé → un
          // accept juste après un save propre rebondissait systématiquement en
          // "diff rafraîchi" au premier clic.
          setContent((prev) => prev ? { ...prev, currentRevisionId: revisionId, body } : prev);
        }}
      />
      <RevisionsPanel revisions={revisions} currentBody={content.body} onRestore={restore} />
    </div>
  );
}
