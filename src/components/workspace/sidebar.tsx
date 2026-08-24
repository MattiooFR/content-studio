"use client";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { countsByBucket, BUCKET_LABELS, type Bucket } from "@/lib/stage";
import { useWorkspaceItems } from "@/components/workspace/items-provider";
import { SubscriptionGauges } from "@/components/cockpit/subscription-gauges";
import { ChatLauncherButton } from "@/components/cockpit/chat-drawer";
import { SignOutButton } from "@/components/sign-out-button";

const BUCKETS: Bucket[] = ["todo", "writing", "published", "discarded"];
const SETTINGS = [
  { href: "/settings/gauges", label: "Jauges" },
  { href: "/settings/tokens", label: "Tokens MCP" },
  { href: "/settings/workspace", label: "Lanes" },
];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const { items } = useWorkspaceItems();
  const counts = useMemo(() => countsByBucket(items), [items]);
  const activeBucket = pathname === "/" ? (params.get("bucket") ?? "todo") : null;
  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-line bg-raised/40">
      <a href="/" className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="size-2 rounded-full bg-accent" aria-hidden />
        <span className="text-sm font-semibold tracking-tight text-ink">content-studio</span>
      </a>
      <nav className="grid gap-0.5 px-2">
        {BUCKETS.map((b) => (
          <a key={b} href={b === "todo" ? "/" : `/?bucket=${b}`}
            aria-current={activeBucket === b ? "page" : undefined}
            className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
              activeBucket === b ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-raised hover:text-ink"}`}>
            {BUCKET_LABELS[b]}
            <span className="text-[11px] tabular-nums text-faint">{counts[b]}</span>
          </a>
        ))}
      </nav>
      <p className="px-4.5 pt-5 pb-1 text-[10px] font-semibold tracking-widest text-faint uppercase">Réglages</p>
      <nav className="grid gap-0.5 px-2">
        {SETTINGS.map((l) => (
          <a key={l.href} href={l.href}
            aria-current={pathname.startsWith(l.href) ? "page" : undefined}
            className={`rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 ${
              pathname.startsWith(l.href) ? "bg-raised font-medium text-ink" : "text-muted hover:bg-raised hover:text-ink"}`}>
            {l.label}
          </a>
        ))}
      </nav>
      <div className="mt-auto grid gap-3 border-t border-line px-4 py-3">
        <SubscriptionGauges vertical />
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs text-muted">{email}</span>
          <div className="flex shrink-0 items-center gap-1"><ChatLauncherButton /><SignOutButton /></div>
        </div>
      </div>
    </aside>
  );
}
