import { describe, it, expect } from "vitest";
import { computeInsertion } from "@/lib/insert-text";

describe("computeInsertion — insertion au curseur", () => {
  it("insère au curseur avec une espace de séparation quand il faut", () => {
    expect(computeInsertion("Bonjour", 7, 7, "tout le monde")).toEqual({ value: "Bonjour tout le monde", caret: 21 });
    expect(computeInsertion("Bonjour ", 8, 8, "tout")).toEqual({ value: "Bonjour tout", caret: 12 });
    expect(computeInsertion("", 0, 0, "Salut")).toEqual({ value: "Salut", caret: 5 });
  });

  it("remplace une sélection et ajoute une espace après si le texte suivant colle", () => {
    expect(computeInsertion("un XXX trois", 3, 6, "deux")).toEqual({ value: "un deux trois", caret: 7 });
    expect(computeInsertion("ab", 1, 1, "X")).toEqual({ value: "a X b", caret: 4 });
  });

  it("singleLine : retours à la ligne → espaces ; texte vide → inchangé ; curseur hors bornes → borné", () => {
    expect(computeInsertion("", 0, 0, "ligne 1\nligne 2\n", { singleLine: true })).toEqual({ value: "ligne 1 ligne 2", caret: 15 });
    expect(computeInsertion("abc", 1, 1, "   ")).toEqual({ value: "abc", caret: 1 });
    expect(computeInsertion("abc", 99, 99, "d")).toEqual({ value: "abc d", caret: 5 });
  });
});
