"use client";
// UN SEUL fetch de /api/ideas pour tout le shell : la sidebar (compteurs), la
// liste et le board consomment le même état, rafraîchi par SSE. Monté dans le
// layout (app) : les pages settings profitent aussi des compteurs.
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";
import type { ItemContent } from "@/lib/stage";

export type WorkspaceItem = {
  id: string; title: string; notes: string; status: string;
  tags: string[]; createdAt: string;
  contentsCount: number; sourcesCount: number;
  lastJobStatus: string | null;
  contents: ItemContent[];
};

type Ctx = { items: WorkspaceItem[]; loaded: boolean; reload: () => void };
const ItemsContext = createContext<Ctx | null>(null);

export function WorkspaceItemsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(() => {
    fetch("/api/ideas")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows) => { if (rows) { setItems(rows); setLoaded(true); } })
      .catch(() => { /* réseau : l'état courant reste affiché, le prochain event retentera */ });
  }, []);
  useEffect(() => { reload(); }, [reload]);
  // content.updated (corps) ne change pas d'étape — volontairement absent.
  useWorkspaceEvents((e) => {
    if (e.type === "idea.created" || e.type === "job.updated" || e.type === "content.status") reload();
  });
  return <ItemsContext.Provider value={{ items, loaded, reload }}>{children}</ItemsContext.Provider>;
}

export function useWorkspaceItems() {
  const ctx = useContext(ItemsContext);
  if (!ctx) throw new Error("useWorkspaceItems hors de WorkspaceItemsProvider");
  return ctx;
}
