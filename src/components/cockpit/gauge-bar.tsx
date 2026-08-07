import { cn } from "@/lib/utils";

export type GaugeSegment = {
  id: string;
  /** 0–100 : part consommée du quota de ce compte. */
  percent: number;
  /** false = compte indisponible → segment hachuré gris, ignoré du chiffre. */
  available: boolean;
};

function fillClass(percent: number) {
  if (percent > 85) return "bg-danger";
  if (percent >= 60) return "bg-warning";
  return "bg-accent/70";
}

/**
 * Jauge fine du header (4px) : un segment par compte, côte à côte. La couleur
 * dépend du remplissage (<60 accent doux, 60–85 warning, >85 danger). Le
 * chiffre affiché est le compte le plus consommé — c'est lui qui bloque.
 */
export function GaugeBar({
  segments,
  label,
  reset,
  className,
}: {
  segments: GaugeSegment[];
  label: string;
  reset?: string;
  className?: string;
}) {
  const clamped = segments.map((s) => ({
    ...s,
    percent: Math.min(100, Math.max(0, s.percent)),
  }));
  const peak = clamped
    .filter((s) => s.available)
    .reduce((max, s) => Math.max(max, s.percent), 0);

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <span
        title={label}
        className="max-w-24 shrink-0 truncate text-[10px] font-medium tracking-widest text-muted uppercase"
      >
        {label}
      </span>
      <div className="flex h-1 min-w-16 flex-1 gap-px">
        {clamped.map((s) => (
          <div
            key={s.id}
            title={
              s.available
                ? `${s.id} — ${Math.round(s.percent)}%`
                : `${s.id} — indisponible`
            }
            className="relative h-full flex-1 overflow-hidden rounded-full bg-raised"
          >
            {s.available ? (
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-150",
                  fillClass(s.percent)
                )}
                style={{ width: `${s.percent}%` }}
              />
            ) : (
              <div
                className="h-full w-full"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, var(--color-line-strong) 0 2px, transparent 2px 5px)",
                }}
              />
            )}
          </div>
        ))}
      </div>
      <span className="shrink-0 text-[11px] font-semibold text-ink tabular-nums">
        {Math.round(peak)}%
      </span>
      {reset && (
        <span className="shrink-0 text-[10px] text-faint tabular-nums">{reset}</span>
      )}
    </div>
  );
}
