"use client";
import * as React from "react";
import { usePathname } from "next/navigation";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/utils";
import { DictateButton } from "@/components/dictate-button";
import { insertAtCursor } from "@/lib/insert-text";
import { mergeRefs } from "@/lib/merge-refs";
import { defaultFieldKey, type DictationProp } from "@/components/ui/textarea";

// Dicter une adresse, un mot de passe ou une URL n'a pas de sens : ces types
// n'ont jamais de micro, quoi que dise la prop.
const NO_DICTATION_TYPES = new Set(["email", "password", "url", "number", "search", "date", "time", "datetime-local", "file", "checkbox", "radio", "hidden", "color", "range"]);

function Input({ className, type, dictation, wrapperClassName, ref, ...props }: React.ComponentProps<"input"> & { dictation?: DictationProp; wrapperClassName?: string }) {
  const inner = React.useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  // Conteneur posé dès que la dictée n'est pas désactivée (et le type non
  // exclu), INDÉPENDAMMENT de disabled/readOnly — cf. commentaire de
  // textarea.tsx (revue finale, I2) : ne pas changer la forme de l'arbre à
  // chaque bascule de `disabled`.
  const showContainer = dictation !== false && !NO_DICTATION_TYPES.has(type ?? "text");
  const micEnabled = showContainer && !props.readOnly && !props.disabled;
  const fieldKey = (dictation && dictation.fieldKey) || defaultFieldKey(pathname, props, "input");
  const el = (
    <InputPrimitive
      ref={mergeRefs(inner, ref)}
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        micEnabled && "pr-8",
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
          className="absolute top-0.5 right-0.5"
        />
      )}
    </div>
  );
}

export { Input }
