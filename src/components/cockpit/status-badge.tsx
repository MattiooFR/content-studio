import { cn } from "@/lib/utils";

type Tone = "muted" | "warning" | "accent" | "success" | "danger";

/**
 * Mapping couleur UNIQUE de tout l'app (contrat W1) : chaque valeur de statut
 * a une seule teinte, quel que soit l'écran. Ne jamais redéfinir ces couleurs
 * ailleurs — étendre ICI si un nouveau statut apparaît.
 */
const VALUE_TONE: Record<string, Tone> = {
  // contenus
  draft: "muted",
  review: "warning",
  approved: "accent",
  published: "success",
  rejected: "danger",
  // sources
  pending: "muted",
  extracted: "success",
  failed: "danger",
  // idées
  inbox: "muted",
  in_progress: "accent",
  done: "success",
  archived: "muted",
  // révisions (panneau contenu)
  current: "success",
  proposed: "warning",
  superseded: "muted",
  // jauges (sources de config)
  quota: "muted",
  cost: "muted",
  enabled: "success",
  disabled: "muted",
  error: "danger",
};

const TONE_CLASS: Record<Tone, string> = {
  muted: "border-line bg-raised text-muted",
  warning: "border-warning/30 bg-warning/10 text-warning",
  accent: "border-accent/40 bg-accent-soft text-accent",
  success: "border-success/30 bg-success/10 text-success",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

export function StatusBadge({
  kind,
  value,
  className,
}: {
  kind: "idea" | "content" | "source" | "gauge";
  value: string;
  className?: string;
}) {
  const tone = VALUE_TONE[value] ?? "muted";
  return (
    <span
      data-kind={kind}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-widest whitespace-nowrap uppercase",
        TONE_CLASS[tone],
        className
      )}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}
