import { cn } from "@/lib/utils";

/**
 * Carte de section du cockpit : surface sombre, bordure fine qui se renforce
 * au survol, header dense (titre 14px semibold + badge + actions à droite),
 * espacement généreux à l'intérieur.
 */
export function SectionCard({
  title,
  icon,
  actions,
  badge,
  className,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  badge?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl border border-line bg-surface p-5 transition-colors duration-150 hover:border-line-strong",
        className
      )}
    >
      <header className="flex min-h-7 items-center gap-2">
        {icon && (
          <span className="flex size-4 shrink-0 items-center justify-center text-muted [&_svg]:size-4">
            {icon}
          </span>
        )}
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {badge}
        {actions && (
          <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}
