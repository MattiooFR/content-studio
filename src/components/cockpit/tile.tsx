import { cn } from "@/lib/utils";

type TileTone = "default" | "accent" | "success" | "warning";

const TONE_TEXT: Record<TileTone, string> = {
  default: "text-ink",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
};

/**
 * Tuile KPI du cockpit : label uppercase 11px, gros chiffre tabular-nums,
 * hint optionnel. La couleur ne porte que la valeur (tone) — le reste est
 * neutre, la hiérarchie vient de la taille et de la graisse.
 */
export function Tile({
  label,
  value,
  hint,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: TileTone;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface p-5 transition-colors duration-150 hover:border-line-strong",
        className
      )}
    >
      <div className="text-[11px] font-medium tracking-widest text-muted uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-2 text-[28px] leading-none font-semibold tabular-nums",
          TONE_TEXT[tone]
        )}
      >
        {value}
      </div>
      {hint !== undefined && <div className="mt-2 text-xs text-muted">{hint}</div>}
    </div>
  );
}
