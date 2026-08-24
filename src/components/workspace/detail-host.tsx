"use client";
// Hôte du volet détail : il ne connaît QUE la référence d'item de l'URL et
// délègue à la fiche correspondante. Aucun fetch ici — les fiches se chargent
// elles-mêmes. `mode` prépare le tiroir mobile (Task 8) sans changer l'inline.
import { IdeaDetail } from "@/components/idea-detail";
import { ContentDetail } from "@/components/content-detail";
import type { WorkspaceItemRef } from "@/lib/workspace-url";

export function DetailHost({ item, onOpenItem, onClose, mode }: {
  item: WorkspaceItemRef | null;
  onOpenItem: (ref: WorkspaceItemRef) => void;
  onClose: () => void;
  mode: "inline" | "drawer";
}) {
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
  return <div className="p-6">{body}</div>; // mode "drawer" : enveloppe ajoutée en Task 8
}
