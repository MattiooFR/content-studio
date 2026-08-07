"use client";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";

// tiptap-markdown@0.9.0 exporte `MarkdownStorage` mais ne le fusionne pas dans
// l'interface `Storage` de @tiptap/core (le point d'extension attendu par tiptap
// v3 pour `editor.storage.<extensionName>`) — sans ceci, `editor.storage.markdown`
// n'existe pas pour le compilateur alors qu'il existe bien à l'exécution
// (voir node_modules/tiptap-markdown/src/Markdown.js: addStorage()/onBeforeCreate()).
declare module "@tiptap/core" {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export type ContentEditorHandle = {
  /**
   * true si l'éditeur a le focus DOM. Proxy fiable de « édition active » côté
   * serveur (editingUntil) : le heartbeat part au focus puis toutes les 15 s
   * tant qu'il reste focus, donc focus ⇒ editingUntil couvert ⇒ le serveur
   * force tout write agent en "proposed". `editor.isFocused` est un booléen
   * tenu à jour en direct par le plugin ProseMirror `focusEvents` (pas une
   * valeur figée au montage) — lu ici sans état React additionnel.
   */
  isEditing: () => boolean;
  /**
   * Fait partir IMMÉDIATEMENT tout save encore en attente d'un debounce, puis
   * attend la fin du save en vol ET de tout renchaînement déjà armé (la file
   * à un slot du Fix round 1 de la Task 11). Invariant (round 3) : après
   * résolution, `saveTimer`/`inFlight`/`pendingSave` sont tous retombés à
   * zéro — plus rien ne peut partir de l'éditeur tout seul.
   */
  flushSaves: () => Promise<void>;
};

export const ContentEditor = forwardRef<ContentEditorHandle, {
  contentId: string;
  initialBody: string;
  // body = le markdown que CE save vient de persister (relu au moment du
  // départ dans runSave, jamais capturé avant) — permet à l'appelant de
  // rafraîchir son état (currentRevisionId + body) sans dépendre du rejeu
  // SSE, qu'il ignore lui-même via ownRevisions (fast-path).
  onSaved: (revisionId: string, body: string) => void;
  /**
   * Corps poussé par SSE (révision devenue current, agent ou user tiers).
   * Round 3 : toute la logique de gate/rejeu vit maintenant ICI, dans
   * l'éditeur — plus dans la page. Voir `pendingRef` plus bas.
   */
  externalBody: { body: string; key: number } | null;
}>(function ContentEditor({ contentId, initialBody, onSaved, externalBody }, ref) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // File d'attente de save à UN slot. Sans ça : une frappe pendant un PATCH en
  // vol arme un second PATCH concurrent, et l'ordre de commit en base suit le
  // réseau, pas l'émission — le save périmé peut écraser le frais (Fix round 1).
  const inFlight = useRef<Promise<void> | null>(null);
  const pendingSave = useRef(false);

  // Round 3 : un externalBody arrivé PENDANT que l'éditeur a le focus n'est
  // JAMAIS appliqué tout de suite (jamais écraser la frappe en cours) — il
  // est stashé ici (le plus récent écrase le précédent) et rejoué au blur.
  // Invalidé par tout save réel de l'éditeur (voir runSave) : un save qui
  // part rend tout pending antérieur périmé par construction, il ne doit
  // jamais être rejoué par-dessus.
  const pendingRef = useRef<{ body: string; key: number } | null>(null);

  // Exécute un save. Le corps est TOUJOURS relu ici, au moment du départ —
  // jamais capturé plus tôt — pour que le save qui repart après un save en
  // vol parte avec le contenu le plus frais, pas celui du moment où il a été
  // demandé.
  function runSave(ed: Editor): Promise<void> {
    const p = (async () => {
      // Notre propre save invalide tout pending antérieur : un externalBody
      // stashé avant ce save reflétait un état qu'on est en train de
      // dépasser nous-mêmes — le rejouer au prochain blur régresserait le
      // travail qu'on vient de committer (bug round 2 #2).
      pendingRef.current = null;
      const body = ed.storage.markdown.getMarkdown();
      setSaveStatus("saving");
      try {
        const res = await fetch(`/api/contents/${contentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        });
        if (res.ok) {
          onSaved((await res.json()).revisionId, body);
          setSaveStatus("saved");
        } else {
          setSaveStatus("error");
        }
      } catch {
        setSaveStatus("error");
      } finally {
        if (pendingSave.current) {
          // une frappe est arrivée pendant ce save : on consomme le drapeau et
          // on renchaîne immédiatement (pas de nouveau debounce) avec le corps
          // frais — relu au tout début du prochain runSave, pas ici.
          pendingSave.current = false;
          inFlight.current = runSave(ed);
        } else {
          inFlight.current = null;
        }
      }
    })();
    return p;
  }

  function scheduleSave(ed: Editor) {
    if (inFlight.current) {
      // un save est déjà en vol : on ne lance PAS de second PATCH concurrent,
      // on marque juste qu'il faudra en relancer un dès que celui-ci termine.
      pendingSave.current = true;
      return;
    }
    inFlight.current = runSave(ed);
  }

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: initialBody,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // PREMIÈRE instruction : le timer vient de tirer, il n'est plus armé.
        // Round 3, bug neuf #1 — sans ce reset, `saveTimer.current` restait
        // non-null pour toujours après la moindre frappe de la session (rien
        // ne le renvoyait à null quand il tirait naturellement) : `flushSaves`
        // croyait alors TOUJOURS un debounce en attente, déclenchait un save
        // à contenu identique à chaque accept, ce qui faisait bouger
        // `currentRevisionId` pour rien — le premier clic Accepter tombait
        // presque systématiquement en « diff rafraîchi » (faux rejet) et
        // semait des révisions parasites.
        saveTimer.current = null;
        scheduleSave(editor);
      }, 1500);
    },
  });

  // heartbeat d'édition : tant que l'éditeur est focus, 1 POST / 15 s
  useEffect(() => {
    const interval = setInterval(() => {
      if (editor?.isFocused) {
        fetch(`/api/contents/${contentId}/editing`, { method: "POST" });
      }
    }, 15_000);
    return () => clearInterval(interval);
  }, [editor, contentId]);

  // premier heartbeat au focus (sinon 15 s de fenêtre sans protection) +
  // au blur (fin d'édition) : rejoue le dernier externalBody stashé pendant
  // qu'on avait le focus, s'il y en a un (round 3 — centralisé ici, pas
  // dans la page).
  useEffect(() => {
    if (!editor) return;
    const onFocus = () =>
      fetch(`/api/contents/${contentId}/editing`, { method: "POST" });
    const onBlur = () => {
      if (pendingRef.current) {
        // emitUpdate: false — ce corps vient du serveur (on vient de le
        // RECEVOIR) : sans ça, setContent émet `update` → onUpdate → debounce
        // → PATCH du corps reçu → révision parasite dont l'écho SSE n'est pas
        // dans ownRevisions → currentRevisionId de la page périmé → faux
        // « diff rafraîchi » au prochain Accepter (fix round 4).
        editor.commands.setContent(pendingRef.current.body, { emitUpdate: false });
        pendingRef.current = null;
      }
    };
    editor.on("focus", onFocus);
    editor.on("blur", onBlur);
    return () => { editor.off("focus", onFocus); editor.off("blur", onBlur); };
  }, [editor, contentId]);

  // Corps poussé de l'extérieur (SSE) — key change à chaque push. Round 3 :
  // vérifie `editor.isFocused` AU MOMENT de l'exécution (pas une valeur
  // capturée plus tôt) — si focus, on ne l'applique JAMAIS pendant la frappe,
  // on le stash pour le rejouer au blur (voir plus haut) ; sinon on l'applique
  // tout de suite. Un stash écrase le précédent — jamais accumulé.
  useEffect(() => {
    if (!editor || !externalBody) return;
    if (editor.isFocused) {
      pendingRef.current = externalBody;
    } else {
      // emitUpdate: false — même raison qu'au blur : une application externe
      // ne doit jamais repartir en PATCH (fix round 4).
      editor.commands.setContent(externalBody.body, { emitUpdate: false });
    }
  }, [editor, externalBody]);

  useImperativeHandle(ref, () => ({
    isEditing: () => editor?.isFocused ?? false,
    flushSaves: async () => {
      // Round 2 : un debounce encore armé (frappe pas encore committée) doit
      // partir MAINTENANT, pas seulement ce qui est déjà en vol — sinon il
      // peut tirer plus tard (après un accept déjà résolu) et écraser
      // silencieusement une version acceptée. `scheduleSave` gère lui-même
      // le cas où un save est déjà en vol (pose juste `pendingSave`).
      //
      // Round 4 : la vérification du timer vit DANS la boucle, pas seulement
      // à l'entrée — une frappe pendant l'attente d'un save en vol réarme un
      // nouveau debounce (`onUpdate` → `setTimeout`), qu'une boucle sur le
      // seul `inFlight` ne reverrait jamais : ce timer tardif aurait tiré
      // APRÈS la résolution du flush, violant l'invariant « après flush,
      // rien ne part tout seul ». Chaque tour draine donc d'abord tout timer
      // armé (clearTimeout + départ immédiat, même mécanique qu'avant), puis
      // attend le vol en cours, et reboucle tant que l'un OU l'autre existe.
      //
      // Boucle et pas un simple `await` unique : quand le save en vol se
      // termine, son propre `finally` peut avoir déjà réassigné
      // `inFlight.current` à un NOUVEAU save (renchaînement `pendingSave`) —
      // cette réassignation est synchrone dans le corps de la fonction async,
      // donc déjà faite avant que la promesse attendue ne se résolve pour de
      // bon. Reboucler garantit qu'on attend TOUT le renchaînement, pas
      // juste le premier maillon.
      while (saveTimer.current || inFlight.current) {
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
          if (editor) scheduleSave(editor);
        }
        if (inFlight.current) {
          await inFlight.current;
        }
      }
    },
  }), [editor]);

  return (
    <div className="space-y-1">
      <div className="prose prose-sm max-w-none rounded-lg border p-4 min-h-[400px]">
        <EditorContent editor={editor} />
      </div>
      <p className="text-xs text-muted-foreground h-4">
        {saveStatus === "saving" && "Enregistrement…"}
        {saveStatus === "saved" && "Enregistré"}
        {saveStatus === "error" && <span className="text-red-600">Échec d&apos;enregistrement</span>}
      </p>
    </div>
  );
});
