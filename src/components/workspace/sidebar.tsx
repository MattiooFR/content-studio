"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { countsByBucket, BUCKET_LABELS, type Bucket } from "@/lib/stage";
import { useWorkspaceItems } from "@/components/workspace/items-provider";
import { useWorkspaceEvents } from "@/hooks/use-workspace-events";
import { SubscriptionGauges } from "@/components/cockpit/subscription-gauges";
import { ChatLauncherButton } from "@/components/cockpit/chat-drawer";
import { SignOutButton } from "@/components/sign-out-button";
import { cn } from "@/lib/utils";

const BUCKETS: Bucket[] = ["todo", "writing", "published", "discarded"];
const WATCH = [
  { href: "/watch", label: "Propositions" },
  { href: "/watch/radar", label: "Radar" },
];
const SETTINGS = [
  { href: "/settings/gauges", label: "Jauges" },
  { href: "/settings/tokens", label: "Tokens MCP" },
  { href: "/settings/workspace", label: "Lanes" },
  { href: "/settings/watch", label: "Veille" },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { items } = useWorkspaceItems();
  const counts = useMemo(() => countsByBucket(items), [items]);
  const activeBucket = pathname === "/" ? (params.get("bucket") ?? "todo") : null;

  // Badge « Propositions » : nombre d'items `proposed` en attente. Fetch
  // initial + rafraîchi sur watch.updated (dépôt du worker, décision prise
  // dans un autre onglet) — même mécanique que items-provider pour les
  // compteurs de buckets, mais résumé par un endpoint dédié plutôt que par
  // la liste complète des items.
  const [proposed, setProposed] = useState(0);

  const loadProposed = useCallback(() => {
    fetch("/api/watch/summary")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { proposed: number } | null) => {
        if (data) setProposed(data.proposed);
      })
      .catch(() => {
        /* badge discret : un échec de fetch n'affiche pas d'erreur, garde le dernier chiffre connu */
      });
  }, []);

  useEffect(() => {
    loadProposed();
  }, [loadProposed]);

  useWorkspaceEvents((e) => {
    if (e.type === "watch.updated") loadProposed();
  });

  // `< lg` : sidebar remplacée par une barre compacte (logo + bouton menu) qui
  // ouvre CETTE MÊME sidebar en overlay par-dessus le contenu — pas de second
  // composant, juste des classes responsives sur le même `<aside>` (spec §8).
  const [mobileOpen, setMobileOpen] = useState(false);

  // Échap ferme l'overlay mobile — écouteur posé seulement tant qu'il est
  // ouvert, même mécanique que le tiroir de détail (Task 8).
  useEffect(() => {
    if (!mobileOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  return (
    <>
      {/* Barre mobile compacte — seule surface visible `< lg` avant ouverture. */}
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-raised/40 px-4 py-2.5 lg:hidden">
        <Link href="/" className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-accent" aria-hidden />
          <span className="text-sm font-semibold tracking-tight text-ink">content-studio</span>
        </Link>
        <button type="button" onClick={() => setMobileOpen((o) => !o)}
          aria-expanded={mobileOpen} aria-label={mobileOpen ? "Fermer le menu" : "Ouvrir le menu"}
          className="rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-raised hover:text-ink">
          ☰
        </button>
      </div>

      {/* Fond de l'overlay mobile — n'existe que le temps de l'ouverture, comme
          le tiroir de détail. `lg:hidden` en garde car `mobileOpen` peut rester
          vrai pendant un redimensionnement vers `≥ lg` (sans effet, la sidebar
          est de toute façon permanente à cette largeur). */}
      {mobileOpen && (
        <button aria-label="Fermer le menu" onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-ink/25 lg:hidden" />
      )}

      <aside
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? "Menu" : undefined}
        className={cn(
          "z-50 h-full w-56 shrink-0 flex-col border-r border-line bg-raised/40",
          mobileOpen ? "fixed inset-y-0 left-0 flex" : "hidden",
          "lg:static lg:flex"
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Link href="/" onClick={() => setMobileOpen(false)}
            className="flex items-center gap-2 px-4 pt-4 pb-3">
            <span className="size-2 rounded-full bg-accent" aria-hidden />
            <span className="text-sm font-semibold tracking-tight text-ink">content-studio</span>
          </Link>
          <nav className="grid gap-0.5 px-2">
            {BUCKETS.map((b) => (
              <Link key={b} href={b === "todo" ? "/" : `/?bucket=${b}`} onClick={() => setMobileOpen(false)}
                aria-current={activeBucket === b ? "page" : undefined}
                className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                  activeBucket === b ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-raised hover:text-ink"}`}>
                {BUCKET_LABELS[b]}
                <span className="text-[11px] tabular-nums text-faint">{counts[b]}</span>
              </Link>
            ))}
          </nav>
          <p className="px-4.5 pt-5 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">Veille</p>
          <nav className="grid gap-0.5 px-2">
            {WATCH.map((l) => (
              // Égalité STRICTE (pas startsWith) : "/watch" est un préfixe de
              // "/watch/radar", startsWith allumerait les deux entrées à la fois.
              <Link key={l.href} href={l.href} onClick={() => setMobileOpen(false)}
                aria-current={pathname === l.href ? "page" : undefined}
                className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                  pathname === l.href ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
                {l.label}
                {l.href === "/watch" && (
                  <span className="text-[11px] tabular-nums text-faint">{proposed}</span>
                )}
              </Link>
            ))}
          </nav>
          <p className="px-4.5 pt-5 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">Réglages</p>
          <nav className="grid gap-0.5 px-2">
            {SETTINGS.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setMobileOpen(false)}
                aria-current={pathname.startsWith(l.href) ? "page" : undefined}
                className={`rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
                  pathname.startsWith(l.href) ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mt-auto grid gap-3 border-t border-line px-4 py-3">
          <SubscriptionGauges vertical />
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">{email}</span>
            <div className="flex shrink-0 items-center gap-1"><ChatLauncherButton /><SignOutButton /></div>
          </div>
        </div>
      </aside>
    </>
  );
}
