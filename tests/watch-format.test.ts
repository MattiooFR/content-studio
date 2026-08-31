import { describe, it, expect } from "vitest";
import { ageRelatif, formaterCompteur, ratioMetriques } from "@/lib/watch-format";

const JOUR_MS = 86_400_000;
const HEURE_MS = 3_600_000;
// Midi UTC : les décalages en jours ne changent jamais de date civile locale
// pour un fuseau raisonnable (± quelques heures), donc les tests restent
// stables quel que soit le fuseau de la machine qui les exécute.
const MAINTENANT = new Date("2026-08-31T12:00:00.000Z");

describe("ageRelatif", () => {
  it("quelques heures → \"il y a N h\"", () => {
    const date = new Date(MAINTENANT.getTime() - 3 * HEURE_MS);
    expect(ageRelatif(date, MAINTENANT)).toBe("il y a 3 h");
  });

  it("borne juste avant 24 h → encore en heures (23 h)", () => {
    const date = new Date(MAINTENANT.getTime() - 23 * HEURE_MS);
    expect(ageRelatif(date, MAINTENANT)).toBe("il y a 23 h");
  });

  it("borne des 24 h → bascule en jours (1 j)", () => {
    const date = new Date(MAINTENANT.getTime() - 24 * HEURE_MS);
    expect(ageRelatif(date, MAINTENANT)).toBe("il y a 1 j");
  });

  it("veille du seuil des 7 jours → encore en jours (6 j)", () => {
    const date = new Date(MAINTENANT.getTime() - 6 * JOUR_MS);
    expect(ageRelatif(date, MAINTENANT)).toBe("il y a 6 j");
  });

  it("borne des 7 jours pleins → date courte, plus de forme relative", () => {
    const date = new Date(MAINTENANT.getTime() - 7 * JOUR_MS);
    const attendu = date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
    const resultat = ageRelatif(date, MAINTENANT);
    expect(resultat).toBe(attendu);
    expect(resultat).not.toMatch(/^il y a/);
  });
});

describe("formaterCompteur", () => {
  it("absent (undefined ou null) → \"—\"", () => {
    expect(formaterCompteur(undefined)).toBe("—");
    expect(formaterCompteur(null)).toBe("—");
  });

  it("zéro → \"0\" (pas \"—\")", () => {
    expect(formaterCompteur(0)).toBe("0");
  });

  it("sous le seuil des milliers → valeur telle quelle", () => {
    expect(formaterCompteur(42)).toBe("42");
    expect(formaterCompteur(999)).toBe("999");
  });

  it("milliers → unité k, une décimale, virgule française", () => {
    expect(formaterCompteur(1234)).toBe("1,2 k");
  });

  it("millier rond → pas de décimale superflue", () => {
    expect(formaterCompteur(2000)).toBe("2 k");
  });

  it("millions → unité M", () => {
    expect(formaterCompteur(1_234_000)).toBe("1,2 M");
  });
});

describe("ratioMetriques", () => {
  it("calculable → 2 décimales, virgule française", () => {
    expect(ratioMetriques(64, 100)).toBe("0,64");
  });

  it("ratio > 1 → toujours 2 décimales", () => {
    expect(ratioMetriques(150, 100)).toBe("1,50");
  });

  it("b absent ou nul → non calculable (\"—\")", () => {
    expect(ratioMetriques(10, 0)).toBe("—");
    expect(ratioMetriques(10, null)).toBe("—");
    expect(ratioMetriques(10, undefined)).toBe("—");
  });

  it("a absent avec b présent → traité comme 0", () => {
    expect(ratioMetriques(null, 100)).toBe("0,00");
    expect(ratioMetriques(undefined, 100)).toBe("0,00");
  });
});
