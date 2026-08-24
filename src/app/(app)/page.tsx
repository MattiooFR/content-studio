"use client";
// La salle de tri : liste à gauche, fiche à droite, tout l'état dans l'URL.
// Aucun state local de navigation — recharger ou partager l'URL reproduit
// l'écran exact.
import { Suspense, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useWorkspaceItems } from "@/components/workspace/items-provider";
import { ItemList } from "@/components/workspace/item-list";
import { Board } from "@/components/workspace/board";
import { ViewSwitch } from "@/components/workspace/view-switch";
import { DetailHost } from "@/components/workspace/detail-host";
import { FunnelLine } from "@/components/cockpit/funnel-line";
import { useIsDesktop } from "@/hooks/use-is-desktop";
import { stageOf, bucketOfStage, BUCKET_STAGES, primaryContentOf } from "@/lib/stage";
import { cn } from "@/lib/utils";
import {
  parseWorkspaceState, serializeWorkspaceState,
  type WorkspaceState, type WorkspaceItemRef,
} from "@/lib/workspace-url";

function Workspace() {
  const params = useSearchParams();
  const state = useMemo(() => parseWorkspaceState(new URLSearchParams(params)), [params]);
  const { items, loaded } = useWorkspaceItems();

  // Navigation sans re-render serveur : replaceState pour la sélection,
  // pushState pour un changement de vue (retour navigateur = vue précédente).
  // Next garde `useSearchParams` synchrone avec l'History API native.
  const apply = useCallback((next: WorkspaceState, push = false) => {
    const url = serializeWorkspaceState(next);
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);

  const openItem = useCallback((ref: WorkspaceItemRef | null) => {
    apply({ ...state, item: ref });
  }, [apply, state]);

  // Changement de vue = pushState : le bouton retour du navigateur revient à
  // la vue précédente (contrairement à la sélection, qui ne pousse jamais).
  const changeView = useCallback((view: WorkspaceState["view"]) => {
    apply({ ...state, view }, true);
  }, [apply, state]);

  // Clic sur un item de liste, ou idée qu'on vient de créer : on ouvre son
  // contenu le plus avancé, sinon l'idée — ET le bucket SUIT la sélection.
  // Sans ça, créer une idée depuis « En rédaction » ouvrait bien sa fiche mais
  // la ligne atterrissait dans « À traiter », invisible et compteur immobile :
  // on croyait l'envoi raté. Un item absent de `items` est une idée tout juste
  // créée (le provider n'a pas encore rechargé) : elle est forcément `proposed`.
  // Les URLs tapées à la main ne sont PAS corrigées au chargement — seule une
  // sélection explicite déplace le bucket.
  const selectIdea = useCallback((ideaId: string) => {
    const it = items.find((i) => i.id === ideaId);
    const primary = it ? primaryContentOf(it.contents) : null;
    const stage = it
      ? stageOf(it.status, it.contents, it.lastJobStatus)
      : stageOf("inbox", [], null);
    // Un seul apply() : bucket et item changent dans la même écriture d'URL.
    apply({
      ...state,
      bucket: bucketOfStage(stage),
      item: primary ? { type: "content", id: primary.id } : { type: "idea", id: ideaId },
    });
  }, [items, apply, state]);

  const visible = useMemo(() => {
    const stages = BUCKET_STAGES[state.bucket];
    return items.filter((i) => stages.includes(stageOf(i.status, i.contents, i.lastJobStatus)));
  }, [items, state.bucket]);

  // idée sélectionnée = l'item de `?item=` (direct, ou parent du contenu ouvert)
  const selectedIdeaId = useMemo(() => {
    if (!state.item) return null;
    if (state.item.type === "idea") return state.item.id;
    const parent = items.find((i) => i.contents.some((c) => c.id === state.item!.id));
    return parent?.id ?? null;
  }, [items, state.item]);

  const isBoard = state.view === "board";
  // Volet inline seulement en vue liste sur desktop (≥ lg) : en board, ou sous
  // `lg`, le même `DetailHost` bascule en tiroir — un seul montage possible,
  // piloté par ce booléen JS (pas de media query CSS, cf. hook + brief §8).
  const isDesktop = useIsDesktop();
  const detailMode: "inline" | "drawer" = isBoard || !isDesktop ? "drawer" : "inline";

  // Clavier j/k : parcourt `visible` dans la vue liste (spec §8). Inerte en
  // vue board, avec le tiroir mobile ouvert (l'utilisateur est dans la fiche,
  // pas dans la liste) ou pendant une saisie — sinon taper un titre commençant
  // par « j » ou « k » ferait sauter la sélection sous les doigts.
  useEffect(() => {
    if (isBoard) return;
    const drawerOpen = detailMode === "drawer" && state.item !== null;
    function isEditableTarget(el: Element | null): boolean {
      if (!el) return false;
      if (el instanceof HTMLElement && el.isContentEditable) return true;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "j" && e.key !== "k") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (drawerOpen) return;
      if (isEditableTarget(document.activeElement)) return;
      if (visible.length === 0) return;
      const idx = visible.findIndex((it) => it.id === selectedIdeaId);
      const step = e.key === "j" ? 1 : -1;
      const nextIdx = idx < 0 ? 0 : Math.min(Math.max(idx + step, 0), visible.length - 1);
      selectIdea(visible[nextIdx].id);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isBoard, detailMode, state.item, visible, selectedIdeaId, selectIdea]);

  return (
    <div className="flex h-full min-h-0">
      {/* Volet inline à côté seulement en `detailMode === "inline"` (liste,
          desktop) : sinon (board, ou liste `< lg`) cette colonne prend toute
          la largeur, le détail s'ouvrant en tiroir par-dessus (spec §2/§8). */}
      <section className={cn(
        "flex min-h-0 flex-col",
        detailMode === "inline" ? "w-80 shrink-0 border-r border-line" : "w-full"
      )}>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2">
          <ViewSwitch view={state.view} onChange={changeView} />
        </div>
        {/* Le pipeline reste consultable mais replié : dans une colonne de 320px
            il mangeait la liste, qui est l'objet de l'écran. */}
        <details className="shrink-0 border-b border-line">
          <summary className="cursor-pointer px-4 py-2.5 text-[10px] font-semibold tracking-widest text-faint uppercase select-none hover:text-muted">
            Pipeline
          </summary>
          <div className="px-4 pb-3"><FunnelLine /></div>
        </details>
        {isBoard ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Le board ignore `bucket` : `items` (non filtré), jamais `visible`. */}
            <Board items={items} selectedId={selectedIdeaId} onSelect={selectIdea} />
          </div>
        ) : (
          <ItemList
            items={visible} bucket={state.bucket} loaded={loaded}
            selectedId={selectedIdeaId} onSelect={selectIdea}
          />
        )}
      </section>
      {detailMode === "inline" ? (
        <section className="min-w-0 flex-1 overflow-y-auto">
          <DetailHost item={state.item} mode="inline"
            onOpenItem={(ref) => openItem(ref)} onClose={() => openItem(null)} />
        </section>
      ) : (
        <DetailHost item={state.item} mode="drawer"
          onOpenItem={(ref) => openItem(ref)} onClose={() => openItem(null)} />
      )}
    </div>
  );
}

export default function WorkspacePage() {
  return <Suspense><Workspace /></Suspense>;
}
