// Tout l'état visible du shell vit dans l'URL : recharger ou partager
// reproduit l'écran exact. Parse tolérant : une valeur inconnue retombe sur
// le défaut, jamais d'exception (les URLs viennent de l'extérieur).
import type { Bucket } from "@/lib/stage";

export type WorkspaceItemRef = { type: "idea" | "content"; id: string };
export type WorkspaceState = {
  view: "list" | "board";
  bucket: Bucket;
  item: WorkspaceItemRef | null;
};

export const DEFAULT_STATE: WorkspaceState = { view: "list", bucket: "todo", item: null };

const VIEWS = new Set(["list", "board"]);
const BUCKETS = new Set(["todo", "writing", "published", "discarded"]);
const ITEM_RE = /^(idea|content):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseWorkspaceState(params: URLSearchParams): WorkspaceState {
  const view = params.get("view") ?? "";
  const bucket = params.get("bucket") ?? "";
  const rawItem = params.get("item") ?? "";
  const m = ITEM_RE.exec(rawItem);
  return {
    view: VIEWS.has(view) ? (view as WorkspaceState["view"]) : DEFAULT_STATE.view,
    bucket: BUCKETS.has(bucket) ? (bucket as Bucket) : DEFAULT_STATE.bucket,
    item: m ? { type: m[1] as WorkspaceItemRef["type"], id: m[2] } : null,
  };
}

export function serializeWorkspaceState(s: WorkspaceState): string {
  const p = new URLSearchParams();
  if (s.view !== DEFAULT_STATE.view) p.set("view", s.view);
  if (s.bucket !== DEFAULT_STATE.bucket) p.set("bucket", s.bucket);
  if (s.item) p.set("item", `${s.item.type}:${s.item.id}`);
  const q = p.toString();
  return q ? `/?${q}` : "/";
}
