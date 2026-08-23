import { describe, it, expect } from "vitest";
import { findPassage, normalizeWs } from "@/lib/anchoring";

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

  // Round 1 — regression : la fin de passage ne doit jamais tronquer une
  // entité HTML ou un bloc d'espaces fusionnés au milieu.
  it("fin de passage ne tronque pas une entité en fin de match (niveau 2)", () => {
    const f = "left&nbsp;right next";
    const r = findPassage(f, "left ", "", "right next");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(2);
    expect(normalizeWs(f.slice(r!.start, r!.end))).toBe(normalizeWs("left "));
    expect(f.slice(r!.start, r!.end).endsWith("&nbsp;")).toBe(true);
  });
  it("fin de passage ne tronque pas une entité en fin de match (niveau 3, repli normalisé)", () => {
    const f = "xxx left&nbsp;right yyy";
    const r = findPassage(f, "left ", "zzz", "zzz");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(3);
    expect(normalizeWs(f.slice(r!.start, r!.end))).toBe(normalizeWs("left "));
    expect(f.slice(r!.start, r!.end).endsWith("&nbsp;")).toBe(true);
  });
  it("entité en tout début de la portion reconnue : la tranche démarre avant l'entité entière", () => {
    const f = "left&nbsp;right";
    const r = findPassage(f, " right", "left", "");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(2);
    expect(normalizeWs(f.slice(r!.start, r!.end))).toBe(normalizeWs(" right"));
    expect(f.slice(r!.start, r!.end).startsWith("&nbsp;")).toBe(true);
  });
  it("match large d'une seule entité : 1 caractère produit correspond aux 6 caractères source", () => {
    const f = "before&nbsp;after";
    const r = findPassage(f, " ", "before", "after");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(2);
    expect(f.slice(r!.start, r!.end)).toBe("&nbsp;");
  });
  it("bloc de deux espaces fusionnés : la borne de fin couvre tout le bloc source", () => {
    const f = "foo  bar"; // deux espaces réels dans la source
    const r = findPassage(f, "foo ", "", "bar");
    expect(r).not.toBeNull();
    expect(r?.level).toBe(2);
    expect(f.slice(r!.start, r!.end)).toBe("foo  "); // les deux espaces sources
  });
});
