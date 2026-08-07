"use client";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Idées" },
  { href: "/settings/gauges", label: "Jauges" },
  { href: "/settings/tokens", label: "Tokens MCP" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") {
    // l'inbox couvre aussi les fiches idée/contenu
    return pathname === "/" || pathname.startsWith("/ideas") || pathname.startsWith("/contents");
  }
  return pathname.startsWith(href);
}

export function NavLinks() {
  const pathname = usePathname();
  return (
    <nav className="flex shrink-0 items-center gap-1">
      {LINKS.map((l) => {
        const active = isActive(pathname, l.href);
        return (
          <a
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150",
              active
                ? "bg-raised font-medium text-ink"
                : "text-muted hover:bg-raised/60 hover:text-ink"
            )}
          >
            {l.label}
          </a>
        );
      })}
    </nav>
  );
}
