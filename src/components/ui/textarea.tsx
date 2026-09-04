"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DictateButton } from "@/components/dictate-button";
import { insertAtCursor } from "@/lib/insert-text";
import { mergeRefs } from "@/lib/merge-refs";

export type DictationProp = false | { fieldKey?: string };

/**
 * Clé de champ par défaut : stable pour une page et un champ donnés (reprise
 * après reload). ATTENTION : tout composant rendu en LISTE (une carte par
 * item, une ligne par entrée…) DOIT poser une clé explicite via la prop
 * `dictation={{ fieldKey: … }}` — sinon toutes les instances de la liste
 * partagent cette même clé par défaut (basée sur le pathname, identique pour
 * toutes les cartes) et une dictée livrée à l'une atterrit dans TOUTES
 * (revue finale, I1).
 */
export function defaultFieldKey(pathname: string, props: { name?: string; id?: string; placeholder?: string }, fallback: string) {
  return `${pathname}#${props.name ?? props.id ?? props.placeholder ?? fallback}`;
}

function Textarea({ className, dictation, wrapperClassName, ref, ...props }: React.ComponentProps<"textarea"> & { dictation?: DictationProp; wrapperClassName?: string }) {
  const inner = React.useRef<HTMLTextAreaElement>(null);
  const pathname = usePathname();
  // Conteneur posé dès que la dictée n'est pas désactivée, INDÉPENDAMMENT de
  // disabled/readOnly : sinon chaque bascule de `disabled` change la forme de
  // l'arbre (élément nu ↔ conteneur) et React démonte/remonte le <textarea>
  // (état du hook perdu, dictée en cours coupée, focus perdu — revue finale, I2).
  const showContainer = dictation !== false;
  const micEnabled = showContainer && !props.readOnly && !props.disabled;
  const fieldKey = (dictation && dictation.fieldKey) || defaultFieldKey(pathname, props, "textarea");
  const el = (
    <textarea
      ref={mergeRefs(inner, ref)}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        micEnabled && "pr-9",
        className
      )}
      {...props}
    />
  );
  if (!showContainer) return el;
  return (
    <div className={cn("relative w-full min-w-0", wrapperClassName)}>
      {el}
      {micEnabled && (
        <DictateButton
          fieldKey={fieldKey}
          recover={!!(dictation && dictation.fieldKey)}
          onText={(t) => insertAtCursor(inner.current, t)}
          className="absolute top-1.5 right-1.5"
        />
      )}
    </div>
  );
}

export { Textarea }
