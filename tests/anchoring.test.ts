import { describe, it, expect } from "vitest";
import { findPassage } from "@/lib/anchoring";

const full = "Intro du post.\n\nOpenAI lance un modèle plus petit, moins cher, et plus rapide.\n\nConclusion.";

describe("findPassage", () => {
  it("niveau 1 : prefix+quote+suffix exacts", () => {
    const r = findPassage(full, "moins cher", "plus petit, ", ", et plus");
    expect(r).toEqual({ start: full.indexOf("moins cher"), end: full.indexOf("moins cher") + "moins cher".length, level: 1 });
  });
  it("niveau 2 : blancs modifiés dans le contexte", () => {
    const r = findPassage(full, "moins cher", "plus  petit,   ", ",\net plus");
    expect(r?.level).toBe(2);
    expect(full.slice(r!.start, r!.end)).toBe("moins cher");
  });
  it("niveau 3 : contexte disparu, quote seule (première occurrence)", () => {
    const r = findPassage(full, "Conclusion", "texte qui n'existe plus ", " idem");
    expect(r?.level).toBe(3);
    expect(full.slice(r!.start, r!.end)).toBe("Conclusion");
  });
  it("introuvable → null ; quote vide → null", () => {
    expect(findPassage(full, "phrase absente", "", "")).toBeNull();
    expect(findPassage(full, "", "Intro", " du")).toBeNull();
  });
  it("entités HTML et apostrophes typographiques normalisées au niveau 2", () => {
    const txt = "L’agent écrit « vite » &amp; bien.";
    const r = findPassage(txt, "vite", "L'agent écrit « ", " » & bien");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(2);
    expect(txt.slice(r!.start, r!.end)).toBe("vite");
  });
});
