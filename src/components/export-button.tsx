"use client";
import { Button } from "@/components/ui/button";

function toPlain(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*]\s+/gm, "→ ")
    .trim();
}

export function ExportButton({ body, format }: { body: string; format: string }) {
  async function copy() {
    await navigator.clipboard.writeText(format === "plain" ? toPlain(body) : body);
  }
  return (
    <Button variant="outline" onClick={copy}>
      Copier ({format === "plain" ? "texte brut" : "markdown"})
    </Button>
  );
}
