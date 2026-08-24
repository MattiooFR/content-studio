"use client";
// Hôte du volet détail : il ne connaît QUE la référence d'item de l'URL et
// délègue à la fiche correspondante. Aucun fetch ici — les fiches se chargent
// elles-mêmes. `mode` "drawer" (vue board, Task 8) superpose la même fiche
// dans un tiroir plutôt que de la mettre en colonne — la fiche elle-même ne
// sait pas dans lequel des deux elle vit.
import { useEffect } from "react";
import { IdeaDetail } from "@/components/idea-detail";
import { ContentDetail } from "@/components/content-detail";
import type { WorkspaceItemRef } from "@/lib/workspace-url";

export function DetailHost({ item, onOpenItem, onClose, mode }: {
  item: WorkspaceItemRef | null;
  onOpenItem: (ref: WorkspaceItemRef) => void;
  onClose: () => void;
  mode: "inline" | "drawer";
}) {
  // Échap ferme le tiroir — écouteur actif SEULEMENT tant qu'il est ouvert,
  // jamais en mode inline (où Échap n'a aucun sens).
  const drawerOpen = mode === "drawer" && item !== null;
  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen, onClose]);

  if (!item) {
    return mode === "inline" ? (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted">
        Sélectionne un élément dans la liste.
      </div>
    ) : null;
  }
  // key={item.id} : remontage propre à chaque changement d'item — l'état interne
  // des fiches (brouillon d'éditeur, onglet, commentaires) ne doit jamais fuiter
  // d'un item à l'autre.
  const body = item.type === "idea"
    ? <IdeaDetail key={item.id} ideaId={item.id} onOpenItem={onOpenItem} />
    : <ContentDetail key={item.id} contentId={item.id} onOpenItem={onOpenItem} />;

  if (mode === "drawer") {
    return (
      <>
        <button aria-label="Fermer" onClick={onClose}
          className="fixed inset-0 z-40 bg-ink/25" />
        <aside role="dialog" aria-modal="true"
          className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl overflow-y-auto border-l border-line bg-bg shadow-2xl">
          <div className="sticky top-0 z-10 flex justify-end border-b border-line bg-bg/90 px-4 py-2 backdrop-blur">
            <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-muted hover:bg-raised hover:text-ink">✕ Fermer</button>
          </div>
          <div className="p-6">{body}</div>
        </aside>
      </>
    );
  }
  return <div className="p-6">{body}</div>;
}
