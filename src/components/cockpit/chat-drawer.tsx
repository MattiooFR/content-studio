"use client";
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import { cn } from "@/lib/utils";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";
import { Button } from "@/components/ui/button";

// ---- types (formes JSON telles que rendues par /api/lanes, dates en ISO) --
type Lane = {
  id: string; title: string; status: "idle" | "running" | "error";
  cliSessionId: string | null; createdAt: string;
};
type ChatMessage = {
  id: string; laneId: string; role: "user" | "agent" | "system";
  body: string; createdAt: string;
};
type MentionItem = { type: "idea" | "content"; id: string; label: string; sublabel: string };
export type MentionRef = { type: "idea" | "content"; id: string; label: string };

// ---- @références : marqueur POSITIONNEL, indépendant du titre -------------
// Fix round 1 (revue) : l'ancien format `[titre](cs://idea/<uuid>)` faisait
// dépendre le pattern du CONTENU du titre — un titre contenant `]` (texte
// libre, cf. src/lib/ideas.ts, aucune contrainte ; fréquent avec l'ingestion
// drop-anything qui ramène des titres de pages web) cassait le match, et le
// fragment `cs://idea/<uuid>)` partait EN CLAIR vers le CLI. Cassait
// l'invariant "cs:// ne doit jamais atteindre le CLI".
//
// Nouveau design : le marqueur inséré dans le textarea est un jeton OPAQUE
// `@⟦N⟧` (délimiteurs `⟦`/`⟧` = U+27E6/U+27E7, quasi impossibles à produire
// par un titre normal) — jamais le titre lui-même. La correspondance
// jeton → {type, id, label} vit dans une table de résolution en état React
// (`mentionRefs`, ChatDrawerProvider), posée à l'insertion (`selectMention`,
// `openForContent`). `resolveMessageForCli` résout TOUJOURS par cette table
// — jamais par un regex qui ré-parse un label. Un titre avec n'importe quel
// caractère (`]`, `)`, `(`, unicode) ne peut donc plus casser la résolution.
// Le jeton reste lisible (visible tel quel, "référence numéro N") et
// effaçable au backspace comme du texte normal.
const MENTION_TOKEN_RE = /@⟦(\d+)⟧/g;
const MAX_CONTEXT_CHARS = 2000;

export function buildMentionMarker(token: string): string {
  return `@⟦${token}⟧`;
}

function truncateContext(text: string, max = MAX_CONTEXT_CHARS): string {
  return text.length <= max ? text : text.slice(0, max) + "…";
}

/**
 * Résout tous les jetons `@⟦N⟧` d'un message AVANT qu'il ne parte en POST,
 * en consultant `refs` (jamais en reparsant le texte du marqueur) : chaque
 * référence unique — dédoublonnée par (type, id), pas par jeton, pour ne
 * poser qu'UN bloc de contexte même si la même idée/contenu est référencée
 * deux fois — est rechargée via les GET existants, réduite à titre + corps
 * tronqué (~2000 caractères), et posée en bloc de contexte AVANT le texte de
 * l'utilisateur (jetons remplacés par leur libellé en clair). Un jeton
 * absent de `refs` (référence supprimée entre-temps, table vidée, etc.) est
 * simplement retiré du texte — jamais bloquant pour l'envoi, et jamais un
 * protocole `cs://` en clair : ce protocole n'existe plus dans ce format.
 */
export async function resolveMessageForCli(
  raw: string,
  refs: ReadonlyMap<string, MentionRef>,
): Promise<string> {
  const matches = [...raw.matchAll(MENTION_TOKEN_RE)];
  const cleaned = raw.replace(MENTION_TOKEN_RE, (_m, token: string) => refs.get(token)?.label ?? "");
  if (matches.length === 0) return cleaned;

  const unique = new Map<string, MentionRef>();
  for (const [, token] of matches) {
    const ref = refs.get(token);
    if (!ref) continue;
    unique.set(`${ref.type}:${ref.id}`, ref);
  }

  const blocks: string[] = [];
  for (const ref of unique.values()) {
    try {
      if (ref.type === "idea") {
        const res = await fetch(`/api/ideas/${ref.id}`);
        if (!res.ok) continue;
        const idea = await res.json();
        blocks.push(`### Idée — ${idea.title}\n${truncateContext(idea.notes ?? "")}`);
      } else {
        const res = await fetch(`/api/contents/${ref.id}`);
        if (!res.ok) continue;
        const content = await res.json();
        const label = content.channel?.name ? `Contenu (${content.channel.name})` : "Contenu";
        blocks.push(`### ${label} — ${ref.label}\n${truncateContext(content.body ?? "")}`);
      }
    } catch {
      // référence injoignable (réseau, 404…) : on continue sans elle, plutôt
      // que de bloquer l'envoi du message.
    }
  }

  if (blocks.length === 0) return cleaned;
  return `${blocks.join("\n\n---\n\n")}\n\n---\n\n${cleaned}`;
}

/** Jeton déjà posé dans `draft` pour CETTE référence (type+id), s'il existe
 * encore dans le texte — évite un doublon si l'action d'insertion est
 * déclenchée deux fois pour la même cible (ex. bouton "💬 Chat" cliqué 2x). */
function findExistingMentionToken(
  refs: ReadonlyMap<string, MentionRef>,
  draft: string,
  type: MentionRef["type"],
  id: string,
): string | null {
  for (const [token, ref] of refs) {
    if (ref.type === type && ref.id === id && draft.includes(buildMentionMarker(token))) return token;
  }
  return null;
}

/** Une lane ciblée par un lien externe (révision "Ouvrir la conversation",
 * favori…) peut avoir été supprimée ou appartenir à un autre workspace : le
 * drawer ne doit jamais s'ouvrir en silence sur un état vide dans ce cas. */
export function resolveLaneOpenOutcome(
  lanes: Pick<Lane, "id">[],
  laneId: string,
): { found: true } | { found: false; message: string } {
  if (lanes.some((l) => l.id === laneId)) return { found: true };
  return { found: false, message: "Conversation introuvable — elle a peut-être été supprimée." };
}

// ---- markdown "simple" (brief : pas un vrai parseur CommonMark) -----------
// Support volontairement minimal : gras/italique/code inline/liens http(s),
// titres `#`, listes `-`/`*`, blocs ```code```. Suffisant pour la sortie
// d'un agent CLI (texte + un peu de mise en forme), pas pour du markdown
// arbitraire — zéro dépendance ajoutée (cf. règle package security du repo).
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <code key={`${keyPrefix}-${i++}`} className="rounded bg-raised px-1 py-0.5 font-mono text-[0.85em]">
          {m[1]}
        </code>
      );
    } else if (m[2] !== undefined) {
      nodes.push(
        <a key={`${keyPrefix}-${i++}`} href={m[3]} target="_blank" rel="noreferrer noopener"
          className="text-accent underline underline-offset-2">
          {m[2]}
        </a>
      );
    } else if (m[4] !== undefined || m[5] !== undefined) {
      nodes.push(<strong key={`${keyPrefix}-${i++}`}>{m[4] ?? m[5]}</strong>);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      nodes.push(<em key={`${keyPrefix}-${i++}`}>{m[6] ?? m[7]}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function SimpleMarkdown({ text }: { text: string }) {
  const segments = text.split(/(```[\s\S]*?```)/g);
  let key = 0;
  return (
    <div className="space-y-1.5">
      {segments.map((seg) => {
        if (seg.startsWith("```")) {
          const code = seg.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, "");
          return (
            <pre key={`code-${key++}`}
              className="overflow-x-auto rounded-lg border border-line bg-bg p-2 font-mono text-xs leading-5">
              {code}
            </pre>
          );
        }
        return seg.split(/\n{2,}/).filter((p) => p.trim() !== "").map((para) => {
          const pKey = `p-${key++}`;
          const heading = para.match(/^(#{1,6})\s+(.*)$/);
          if (heading) {
            return (
              <p key={pKey} className={heading[1].length <= 2 ? "text-sm font-semibold" : "text-sm font-medium"}>
                {renderInline(heading[2], pKey)}
              </p>
            );
          }
          const lines = para.split("\n");
          if (lines.every((l) => /^\s*[-*]\s+/.test(l) || l.trim() === "")) {
            return (
              <ul key={pKey} className="list-disc space-y-0.5 pl-4">
                {lines.filter((l) => l.trim() !== "").map((l, i) => (
                  <li key={`${pKey}-${i}`}>{renderInline(l.replace(/^\s*[-*]\s+/, ""), `${pKey}-${i}`)}</li>
                ))}
              </ul>
            );
          }
          return (
            <p key={pKey} className="whitespace-pre-wrap">
              {lines.flatMap((l, i) => (
                i === 0 ? renderInline(l, `${pKey}-${i}`)
                  : [<br key={`${pKey}-br-${i}`} />, ...renderInline(l, `${pKey}-${i}`)]
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}

// ---- détection de la mention "@" active dans le textarea -------------------
// "@" doit être précédé du début du texte / d'un espace / d'un saut de ligne
// (jamais au milieu d'une adresse email par ex.) ; la requête s'arrête au
// premier espace ou saut de ligne rencontré en revenant du curseur.
function detectMention(value: string, cursor: number): { start: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const c = value[i];
    if (c === "\n" || c === " ") return null;
    if (c === "@") {
      const prev = value[i - 1];
      if (i === 0 || prev === " " || prev === "\n") {
        return { start: i, query: value.slice(i + 1, cursor) };
      }
      return null;
    }
    i--;
  }
  return null;
}

function mergeMarkerIntoDraft(draft: string, marker: string): string {
  if (draft.includes(marker)) return draft; // déjà présent (ex. bouton chat cliqué 2 fois) — pas de doublon
  return draft.length === 0 ? marker + " " : draft.replace(/\s*$/, "") + " " + marker + " ";
}

// ---- contexte partagé --------------------------------------------------
type ChatDrawerCtx = {
  openGlobal: () => void;
  /** Ouvre le drawer directement sur `laneId` (lien "ouvrir la conversation" d'une révision). */
  openLaneById: (laneId: string) => void;
  /** Crée/ouvre la lane titrée de ce contenu, avec son contexte pré-inséré dans le brouillon. */
  openForContent: (opts: { title: string; contentId: string }) => Promise<void>;
  /** Champ additif (revue finale) : le drawer de chat est-il ouvert ? Sert au
   * tiroir détail (detail-host.tsx) pour ignorer Échap quand le chat est
   * au-dessus de lui — sinon Échap fermait le mauvais tiroir. */
  isOpen: boolean;
};

const Ctx = createContext<ChatDrawerCtx | null>(null);

export function useChatDrawer(): ChatDrawerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useChatDrawer doit être appelé sous ChatDrawerProvider");
  return ctx;
}

export function ChatDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [activeLaneId, setActiveLaneId] = useState<string | null>(null);
  const [messagesByLane, setMessagesByLane] = useState<Record<string, ChatMessage[]>>({});
  const [streamingByLane, setStreamingByLane] = useState<Record<string, string>>({});
  const [busyByLane, setBusyByLane] = useState<Record<string, boolean>>({});
  const [draftByLane, setDraftByLane] = useState<Record<string, string>>({});
  const [noticeByLane, setNoticeByLane] = useState<Record<string, string | null>>({});
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionItems, setMentionItems] = useState<MentionItem[] | null>(null);
  // Table de résolution des jetons `@⟦N⟧` → référence — voir MENTION_TOKEN_RE.
  const [mentionRefs, setMentionRefs] = useState<Map<string, MentionRef>>(new Map());
  /** Lien vers une lane introuvable (supprimée, autre workspace) : message
   * visible au lieu d'un drawer vide muet — voir resolveLaneOpenOutcome. */
  const [openError, setOpenError] = useState<string | null>(null);

  // Miroirs en ref des états lus depuis des callbacks exposées au contexte
  // (openLaneById, openForContent…) — évite les fermetures périmées sans
  // devoir refaire de `fetch` déjà en cours à chaque appel.
  const activeLaneIdRef = useRef<string | null>(null);
  const messagesByLaneRef = useRef<Record<string, ChatMessage[]>>({});
  // Générateur de jetons monotone — délibérément un ref (pas dans la table
  // d'état elle-même) : incrémente de façon synchrone y compris si deux
  // insertions arrivent avant qu'un rendu ne passe, ce qu'un compteur dérivé
  // de `mentionRefs.size` ne garantirait pas.
  const nextMentionTokenRef = useRef(1);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);

  const registerMentionRef = useCallback((item: Pick<MentionItem, "type" | "id" | "label">): string => {
    const token = String(nextMentionTokenRef.current++);
    setMentionRefs((prev) => {
      const next = new Map(prev);
      next.set(token, { type: item.type, id: item.id, label: item.label });
      return next;
    });
    return token;
  }, []);

  const loadLanes = useCallback(async (): Promise<Lane[]> => {
    const res = await fetch("/api/lanes");
    const list: Lane[] = res.ok ? await res.json() : [];
    setLanes(list);
    return list;
  }, []);

  const loadMessages = useCallback(async (laneId: string) => {
    const res = await fetch(`/api/lanes/${laneId}/messages`);
    if (!res.ok) return;
    const msgs: ChatMessage[] = await res.json();
    setMessagesByLane((m) => {
      const next = { ...m, [laneId]: msgs };
      messagesByLaneRef.current = next;
      return next;
    });
  }, []);

  const selectLane = useCallback((laneId: string | null) => {
    setActiveLaneId(laneId);
    activeLaneIdRef.current = laneId;
    setMention(null);
    if (laneId && !messagesByLaneRef.current[laneId]) loadMessages(laneId);
  }, [loadMessages]);

  useEffect(() => {
    loadLanes();
  }, [loadLanes]);

  // ---- SSE : chunks live, refresh au done/error ----------------------------
  useWorkspaceEvents((e) => {
    if (e.type !== "lane.message") return;
    const { laneId, event } = e;
    if (event.type === "chunk") {
      setStreamingByLane((s) => ({ ...s, [laneId]: (s[laneId] ?? "") + event.text }));
      return;
    }
    setStreamingByLane((s) => ({ ...s, [laneId]: "" }));
    setBusyByLane((b) => ({ ...b, [laneId]: false }));
    loadMessages(laneId);
    loadLanes(); // status idle/error à jour sur la pill
    if (event.type === "error") setNoticeByLane((n) => ({ ...n, [laneId]: event.message }));
  });

  const createLane = useCallback(async (title?: string): Promise<Lane> => {
    const res = await fetch("/api/lanes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(title ? { title } : {}),
    });
    const lane: Lane = await res.json();
    setLanes((prev) => [...prev, lane]);
    return lane;
  }, []);

  const openGlobal = useCallback(() => {
    setOpen(true);
    setOpenError(null);
    loadLanes().then((list) => {
      const keep = activeLaneIdRef.current;
      const target = keep && list.some((l) => l.id === keep) ? keep : (list.at(-1)?.id ?? null);
      selectLane(target);
    });
  }, [loadLanes, selectLane]);

  const openLaneById = useCallback((laneId: string) => {
    setOpen(true);
    setOpenError(null);
    loadLanes().then((list) => {
      const outcome = resolveLaneOpenOutcome(list, laneId);
      if (!outcome.found) {
        // lien périmé (lane supprimée / autre workspace) : jamais un drawer
        // vide muet — cf. Minor de la revue W11-fix1.
        setOpenError(outcome.message);
        selectLane(null);
        return;
      }
      selectLane(laneId);
    });
  }, [loadLanes, selectLane]);

  const openForContent = useCallback(async ({ title, contentId }: { title: string; contentId: string }) => {
    const list = await loadLanes();
    let lane = list.find((l) => l.title === title);
    if (!lane) lane = await createLane(title);
    selectLane(lane.id);
    const laneId = lane.id;
    const currentDraft = draftByLane[laneId] ?? "";
    const existingToken = findExistingMentionToken(mentionRefs, currentDraft, "content", contentId);
    const token = existingToken ?? registerMentionRef({ type: "content", id: contentId, label: title });
    const marker = buildMentionMarker(token);
    setDraftByLane((d) => ({ ...d, [laneId]: mergeMarkerIntoDraft(d[laneId] ?? "", marker) }));
    setOpen(true);
  }, [loadLanes, createLane, selectLane, draftByLane, mentionRefs, registerMentionRef]);

  const send = useCallback(async () => {
    const laneId = activeLaneIdRef.current;
    if (!laneId) return;
    const raw = (draftByLane[laneId] ?? "").trim();
    if (!raw || busyByLane[laneId]) return;

    setNoticeByLane((n) => ({ ...n, [laneId]: null }));
    setMention(null);

    let resolved: string;
    try {
      resolved = await resolveMessageForCli(raw, mentionRefs);
    } catch {
      resolved = raw.replace(MENTION_TOKEN_RE, (_m, token: string) => mentionRefs.get(token)?.label ?? "");
    }

    // bulle optimiste : la route POST persiste le message user en
    // fire-and-forget côté serveur (jamais attendu par la réponse HTTP), donc
    // sans ceci l'utilisateur ne verrait rien avant le premier chunk agent.
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`, laneId, role: "user", body: resolved,
      createdAt: new Date().toISOString(),
    };
    setMessagesByLane((m) => {
      const next = { ...m, [laneId]: [...(m[laneId] ?? []), optimistic] };
      messagesByLaneRef.current = next;
      return next;
    });
    setDraftByLane((d) => ({ ...d, [laneId]: "" }));
    setBusyByLane((b) => ({ ...b, [laneId]: true }));
    setStreamingByLane((s) => ({ ...s, [laneId]: "" }));

    let res: Response;
    try {
      res = await fetch(`/api/lanes/${laneId}/messages`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: resolved }),
      });
    } catch {
      setNoticeByLane((n) => ({ ...n, [laneId]: "Échec réseau — réessaie." }));
      setBusyByLane((b) => ({ ...b, [laneId]: false }));
      return;
    }
    if (res.status === 409) {
      setNoticeByLane((n) => ({ ...n, [laneId]: "déjà en cours pour cette lane" }));
      setBusyByLane((b) => ({ ...b, [laneId]: true }));
      return;
    }
    if (!res.ok) {
      setNoticeByLane((n) => ({ ...n, [laneId]: "Échec de l'envoi — réessaie." }));
      setBusyByLane((b) => ({ ...b, [laneId]: false }));
      return;
    }
    loadLanes();
  }, [draftByLane, busyByLane, loadLanes, mentionRefs]);

  const ensureMentionItems = useCallback(async (): Promise<MentionItem[]> => {
    if (mentionItems) return mentionItems;
    const [ideasRes, contentsRes] = await Promise.all([fetch("/api/ideas"), fetch("/api/contents")]);
    const ideasList = ideasRes.ok ? await ideasRes.json() : [];
    const contentsList = contentsRes.ok ? await contentsRes.json() : [];
    const ideaTitleById = new Map<string, string>(
      ideasList.map((i: { id: string; title: string }) => [i.id, i.title])
    );
    const items: MentionItem[] = [
      ...ideasList.map((i: { id: string; title: string }) => ({
        type: "idea" as const, id: i.id, label: i.title, sublabel: "idée",
      })),
      ...contentsList.map((c: { id: string; ideaId: string; status: string }) => ({
        type: "content" as const, id: c.id,
        label: ideaTitleById.get(c.ideaId) ?? "contenu", sublabel: c.status,
      })),
    ];
    setMentionItems(items);
    return items;
  }, [mentionItems]);

  const filteredMentionItems = useMemo(() => {
    if (!mention || !mentionItems) return [];
    const q = mention.query.toLowerCase();
    return mentionItems
      .filter((it) => it.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mention, mentionItems]);

  const selectMention = useCallback((item: MentionItem) => {
    const laneId = activeLaneIdRef.current;
    if (!laneId || !mention) return;
    const value = draftByLane[laneId] ?? "";
    const cursor = mention.start + 1 + mention.query.length;
    const token = registerMentionRef(item);
    const marker = buildMentionMarker(token);
    const nextValue = value.slice(0, mention.start) + marker + " " + value.slice(cursor);
    setDraftByLane((d) => ({ ...d, [laneId]: nextValue }));
    setMention(null);
    // remet le focus + curseur juste après le marqueur inséré.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = mention.start + marker.length + 1;
      el.setSelectionRange(pos, pos);
    });
  }, [mention, draftByLane, registerMentionRef]);

  function onDraftChange(laneId: string, value: string, cursor: number) {
    setDraftByLane((d) => ({ ...d, [laneId]: value }));
    const m = detectMention(value, cursor);
    setMention(m);
    setMentionIndex(0);
    if (m) ensureMentionItems();
  }

  const ctxValue = useMemo<ChatDrawerCtx>(() => ({ openGlobal, openLaneById, openForContent, isOpen: open }), [
    openGlobal, openLaneById, openForContent, open,
  ]);

  const activeMessages = activeLaneId ? (messagesByLane[activeLaneId] ?? []) : [];
  const activeStreaming = activeLaneId ? (streamingByLane[activeLaneId] ?? "") : "";
  const activeDraft = activeLaneId ? (draftByLane[activeLaneId] ?? "") : "";
  const activeBusy = activeLaneId ? !!busyByLane[activeLaneId] : false;
  const activeNotice = activeLaneId ? noticeByLane[activeLaneId] : null;

  // Auto-scroll en bas à chaque nouveau message ET à chaque chunk de
  // streaming (pas seulement au changement de lane) — sans ça, une réponse
  // plus longue que la fenêtre visible reste coupée tant que l'utilisateur
  // ne scrolle pas lui-même à la main (constaté en vérification manuelle :
  // persisté correct en base, juste hors champ visuellement).
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeLaneId, activeMessages, activeStreaming]);

  return (
    <Ctx.Provider value={ctxValue}>
      {children}
      {open && (
        <div
          className={cn(
            "fixed inset-0 z-50 flex flex-col border-l border-line bg-surface shadow-2xl",
            "sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[480px]"
          )}
          role="dialog"
          aria-label="Conversation avec l'agent"
        >
          {/* header : onglets de lanes + fermer */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {lanes.map((lane, i) => {
                // busyByLane est optimiste (posé dès l'envoi, avant même la
                // réponse HTTP) — combiné à lane.status pour ne jamais rater
                // le point "en cours" à cause de la course entre notre POST
                // et le prochain GET /api/lanes (runLaneMessage passe le
                // status à "running" en fire-and-forget côté serveur).
                const running = !!busyByLane[lane.id] || lane.status === "running";
                return (
                  <button
                    key={lane.id}
                    type="button"
                    title={lane.title}
                    onClick={() => selectLane(lane.id)}
                    className={cn(
                      "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium tracking-wider uppercase transition-colors duration-150",
                      lane.id === activeLaneId ? "bg-accent-soft text-accent" : "text-muted hover:bg-raised hover:text-ink"
                    )}
                  >
                    {running && <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden />}
                    {!running && lane.status === "error" && <span className="size-1.5 rounded-full bg-danger" aria-hidden />}
                    {i + 1}
                  </button>
                );
              })}
              <button
                type="button"
                aria-label="Nouvelle conversation"
                title="Nouvelle conversation"
                onClick={() => createLane().then((lane) => selectLane(lane.id))}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-raised hover:text-ink"
              >
                +
              </button>
            </div>
            <a href="/settings/workspace" title="Réglages de la commande CLI"
              className="shrink-0 text-xs text-faint transition-colors duration-150 hover:text-ink">
              ⚙
            </a>
            <button
              type="button" aria-label="Fermer" onClick={() => setOpen(false)}
              className="shrink-0 text-sm text-faint transition-colors duration-150 hover:text-ink"
            >
              ✕
            </button>
          </div>

          {/* historique */}
          <div ref={historyRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {!activeLaneId ? (
              openError ? (
                <p className="text-sm text-danger">{openError}</p>
              ) : (
                <p className="text-sm text-muted">
                  Aucune conversation. Crée-en une avec le bouton{" "}
                  <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px]">+</span> ci-dessus.
                </p>
              )
            ) : (
              <>
                {activeMessages.length === 0 && !activeStreaming && (
                  <p className="text-sm text-muted">Aucun message pour l&apos;instant — écris ci-dessous.</p>
                )}
                {activeMessages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}
                {activeStreaming && (
                  <MessageBubble
                    message={{ id: "streaming", laneId: activeLaneId, role: "agent", body: activeStreaming, createdAt: "" }}
                    streaming
                  />
                )}
              </>
            )}
          </div>

          {/* composer */}
          {activeLaneId && (
            <div className="relative shrink-0 border-t border-line p-3">
              {mention && (
                <div className="absolute bottom-full left-3 z-10 mb-1 max-h-56 w-[calc(100%-1.5rem)] overflow-y-auto rounded-lg border border-line bg-raised p-1 shadow-xl">
                  {filteredMentionItems.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-faint">
                      {mentionItems === null ? "Chargement…" : "Aucun résultat."}
                    </p>
                  ) : (
                    filteredMentionItems.map((item, i) => (
                      <button
                        key={`${item.type}-${item.id}`}
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); selectMention(item); }}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-150",
                          i === mentionIndex ? "bg-accent-soft text-accent" : "text-ink hover:bg-bg"
                        )}
                      >
                        <span className="truncate">{item.label}</span>
                        <span className="shrink-0 text-[10px] tracking-wider text-faint uppercase">{item.sublabel}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {activeNotice && <p className="mb-2 text-xs text-warning">{activeNotice}</p>}
              <div className="flex items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={activeDraft}
                  disabled={activeBusy}
                  placeholder={activeBusy ? "en cours…" : "Écris un message — @ pour référencer une idée ou un contenu"}
                  onChange={(e) => onDraftChange(activeLaneId, e.target.value, e.target.selectionStart)}
                  onClick={(e) => onDraftChange(activeLaneId, e.currentTarget.value, e.currentTarget.selectionStart)}
                  onKeyDown={(e) => {
                    if (mention) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setMentionIndex((i) => Math.min(i + 1, Math.max(filteredMentionItems.length - 1, 0))); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setMentionIndex((i) => Math.max(i - 1, 0)); return; }
                      if (e.key === "Escape") { e.preventDefault(); setMention(null); return; }
                      if ((e.key === "Enter" || e.key === "Tab") && filteredMentionItems[mentionIndex]) {
                        e.preventDefault(); selectMention(filteredMentionItems[mentionIndex]); return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
                  }}
                  rows={2}
                  className="min-h-16 w-full flex-1 resize-none rounded-lg border border-line bg-raised px-2.5 py-2 text-sm text-ink outline-none placeholder:text-faint focus-visible:border-accent disabled:opacity-60"
                />
                <Button
                  type="button"
                  onClick={send}
                  disabled={activeBusy || !activeDraft.trim()}
                  className="h-9 shrink-0 px-3"
                >
                  Envoyer
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Ctx.Provider>
  );
}

function MessageBubble({ message, streaming }: { message: ChatMessage; streaming?: boolean }) {
  if (message.role === "system") {
    return <p className="px-2 text-center text-[12px] text-muted">{message.body}</p>;
  }
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-sm",
          isUser ? "bg-raised text-ink" : "border border-line bg-surface text-ink"
        )}
      >
        {isUser ? (
          <span className="whitespace-pre-wrap">{message.body}</span>
        ) : (
          <SimpleMarkdown text={message.body || "…"} />
        )}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent/60 align-middle" aria-hidden />}
      </div>
    </div>
  );
}

/** Bouton du header (global) : ouvre le drawer sur la dernière lane utilisée, ou l'état vide. */
export function ChatLauncherButton() {
  const { openGlobal } = useChatDrawer();
  return (
    <button
      type="button"
      onClick={openGlobal}
      title="Ouvrir le chat"
      className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-sm text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
    >
      <span aria-hidden>💬</span>
      <span className="hidden sm:inline">Chat</span>
    </button>
  );
}
