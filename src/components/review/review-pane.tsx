"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { findPassage } from "@/lib/anchoring";
import { useComments, type Anchor } from "@/components/review/use-comments";
import { CommentPopover } from "@/components/review/comment-popover";
import { CommentList } from "@/components/review/comment-list";

/** Contexte capturé de part et d'autre de la sélection, pour l'ancrage. */
const CONTEXT = 40;
const POPOVER_WIDTH = 330;
const supportsHighlights = () => typeof CSS !== "undefined" && "highlights" in CSS;

/**
 * Offsets dans `root.textContent` → `Range` DOM, via un TreeWalker sur les
 * nœuds texte (cumul des longueurs). Même ordre de parcours que
 * `textContent`, donc les offsets se correspondent exactement.
 */
function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null; let startOff = 0;
  let endNode: Text | null = null; let endOff = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!startNode && start < pos + len) { startNode = n; startOff = start - pos; }
    if (end <= pos + len) { endNode = n; endOff = end - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return null;
  const r = document.createRange();
  r.setStart(startNode, startOff);
  r.setEnd(endNode, endOff);
  return r;
}

/** Offset d'un point DOM dans `root.textContent`. */
function offsetOf(root: HTMLElement, node: Node, off: number): number {
  const r = document.createRange();
  r.setStart(root, 0);
  r.setEnd(node, off);
  return r.toString().length;
}

/** Dernier titre h1-h3 qui précède `offset` — la « section » du commentaire. */
function sectionBefore(root: HTMLElement, offset: number): string {
  let best = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode() as HTMLElement | null; n; n = walker.nextNode() as HTMLElement | null) {
    if (!/^H[1-3]$/.test(n.tagName)) continue;
    if (offsetOf(root, n, 0) <= offset) best = n.textContent ?? "";
    else break;
  }
  return best.slice(0, 300);
}

/**
 * Onglet « Relire » : le corps rendu en lecture seule (tiptap `editable:false`,
 * donc DOM stable et sélectionnable), les passages commentés surlignés via la
 * CSS Custom Highlight API — aucune mutation du DOM rendu par tiptap, donc
 * aucun conflit avec React —, et la colonne des commentaires à droite.
 */
export function ReviewPane({ contentId, body }: { contentId: string; body: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { comments, error, createText, createVoice, update, remove } = useComments(contentId);
  const [pending, setPending] = useState<{ anchor: Anchor; start: number; end: number } | null>(null);
  // On garde l'ID, pas la ligne : `useComments` remplace le tableau à chaque
  // rafraîchissement SSE, et un instantané de `CommentRow` ne suivrait jamais.
  // Concrètement (revue Task 15, finding I1) : un popover ouvert sur une
  // dictée en cours restait bloqué sur « Transcription en cours… » — la
  // transcription arrivée par `comment.updated` ne l'atteignait pas. Dériver
  // la ligne du tableau courant règle aussi la suppression depuis un autre
  // onglet : la ligne disparaît, `selected` retombe à null, le popover se
  // ferme tout seul.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [general, setGeneral] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const [lost, setLost] = useState<Set<string>>(new Set());
  // compteur bumpé quand le DOM du document change : garantit que les
  // surlignages sont (re)calculés APRÈS que tiptap a peuplé le DOM, y
  // compris au tout premier rendu (immediatelyRender: false).
  const [docVersion, setDocVersion] = useState(0);
  const hl = useMemo(supportsHighlights, []);
  const selected = useMemo(
    () => comments.find((c) => c.id === selectedId) ?? null,
    [comments, selectedId]
  );

  const editor = useEditor({
    extensions: [StarterKit, Markdown],
    content: body, editable: false, immediatelyRender: false,
  });

  // Corps rafraîchi depuis le serveur (SSE content.updated, ou retour d'onglet).
  // emitUpdate: false — rien ne doit repartir en écriture depuis la relecture.
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(body, { emitUpdate: false });
    setDocVersion((n) => n + 1);
  }, [editor, body]);

  // Surlignages : vert = commentaires ouverts et ancrés, jaune = sélection en
  // cours. `lost` est calculé même sans la Highlight API — c'est lui qui pilote
  // le « ⚠️ passage introuvable » de la colonne.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !editor) return;
    const full = root.textContent ?? "";
    const anchored: Range[] = [];
    const lostIds = new Set<string>();
    for (const c of comments) {
      if (!c.quote || c.status !== "open") continue;
      const p = findPassage(full, c.quote, c.prefix, c.suffix);
      const r = p ? rangeFromOffsets(root, p.start, p.end) : null;
      if (r) anchored.push(r); else lostIds.add(c.id);
    }
    setLost(lostIds);
    // `new Highlight()` n'existe pas sans la Highlight API : ne rien
    // construire avant ce test, sinon le composant entier casse là où le
    // surlignage est seulement censé manquer.
    if (!hl) return;
    CSS.highlights.set("cs-comment", new Highlight(...anchored));
    const pendingRange = pending ? rangeFromOffsets(root, pending.start, pending.end) : null;
    CSS.highlights.set("cs-pending", pendingRange ? new Highlight(pendingRange) : new Highlight());
    return () => { CSS.highlights.delete("cs-comment"); CSS.highlights.delete("cs-pending"); };
  }, [comments, pending, editor, docVersion, hl]);

  // Sélection (ou simple clic dans un passage déjà commenté) → popover.
  const onMouseUp = useCallback(() => {
    const root = rootRef.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    if (!sel.anchorNode || !sel.focusNode) return;
    if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return;
    const range = sel.getRangeAt(0);
    const full = root.textContent ?? "";
    const start = offsetOf(root, range.startContainer, range.startOffset);
    const end = offsetOf(root, range.endContainer, range.endOffset);

    const rect = range.getBoundingClientRect();
    const host = root.getBoundingClientRect();
    // Math.max(0, …) sur le top : une sélection repliée (simple clic) peut
    // rendre un rect à zéro selon le navigateur — sans borne, le popover
    // partirait au-dessus du cadre, hors écran.
    const place = () => setPopoverStyle({
      top: Math.max(0, rect.bottom - host.top + 8),
      left: Math.max(0, Math.min(rect.left - host.left, host.width - POPOVER_WIDTH)),
    });

    // clic (ou sélection) DANS un passage déjà commenté → rouvrir ce
    // commentaire plutôt que d'en créer un second au même endroit.
    const hit = comments.find((c) => {
      if (!c.quote || c.status !== "open") return false;
      const p = findPassage(full, c.quote, c.prefix, c.suffix);
      return !!p && p.start <= start && end <= p.end;
    });
    if (hit) {
      place();
      setSelectedId(hit.id); setPending(null); setGeneral(false);
      sel.removeAllRanges();
      return;
    }
    // simple clic hors passage commenté : rien à ancrer
    if (sel.isCollapsed || end <= start) return;
    const quote = full.slice(start, end);
    if (!quote.trim()) return;
    place();
    setSelectedId(null); setGeneral(false);
    setPending({
      anchor: {
        quote: quote.slice(0, 2000),
        prefix: full.slice(Math.max(0, start - CONTEXT), start),
        suffix: full.slice(end, end + CONTEXT),
        section: sectionBefore(root, start),
      },
      start, end,
    });
    sel.removeAllRanges();
  }, [comments]);

  const close = () => { setPending(null); setSelectedId(null); setGeneral(false); };
  const anchorForSave = pending?.anchor ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div className="relative">
        {/* Les teintes viennent des tokens du design system (aucune couleur
            brute hors globals.css) ; translucides pour que le texte reste
            lisible sur le fond sombre. */}
        <style>{`
          ::highlight(cs-pending){background-color:color-mix(in oklch, var(--color-warning) 35%, transparent);}
          ::highlight(cs-comment){background-color:color-mix(in oklch, var(--color-success) 28%, transparent);}
        `}</style>
        <div ref={rootRef} onMouseUp={onMouseUp}
          className="max-w-none rounded-xl border border-line bg-surface p-5 text-sm leading-relaxed select-text">
          <EditorContent editor={editor} />
        </div>
        {(pending || selected || general) && (
          <CommentPopover
            existing={selected}
            style={general ? { top: 8, right: 8 } : popoverStyle}
            onSaveText={async (text) => {
              if (selected) await update(selected.id, { body: text });
              else await createText(text, general ? null : anchorForSave);
              close();
            }}
            onSaveVoice={async (blob, mime) => {
              const created = await createVoice(blob, mime, general ? null : anchorForSave);
              // On NE ferme PAS : on bascule le popover sur le commentaire
              // qui vient d'être créé, pour que l'utilisateur voie
              // « Transcription en cours… » puis le texte arriver par SSE.
              // (`createVoice` a déjà rafraîchi la liste, donc `selected`
              // résout immédiatement.) En cas d'échec, `created` est null et
              // le message d'erreur du hook s'affiche sous le corps.
              setPending(null); setGeneral(false);
              setSelectedId(created?.id ?? null);
            }}
            onResolve={selected ? async () => { await update(selected.id, { status: "resolved" }); close(); } : undefined}
            onDelete={selected ? async () => { await remove(selected.id); close(); } : undefined}
            onClose={close}
          />
        )}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      <CommentList comments={comments} lost={lost} highlightsSupported={hl}
        onSelect={(c) => {
          setSelectedId(c.id); setPending(null); setGeneral(false);
          setPopoverStyle({ top: 8, right: 8 });
        }}
        onGeneral={() => { setGeneral(true); setSelectedId(null); setPending(null); }} />
    </div>
  );
}
