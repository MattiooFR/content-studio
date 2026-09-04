// Insertion d'un texte dicté au curseur d'un champ, SANS connaître l'état
// React qui le contrôle : la partie pure (testée) calcule la nouvelle valeur,
// la glue DOM pose la valeur par le setter natif puis dispatch `input` —
// React déclenche `onChange` comme pour une frappe.

export function computeInsertion(
  value: string, selStart: number, selEnd: number, text: string,
  opts: { singleLine?: boolean } = {},
): { value: string; caret: number } {
  let t = opts.singleLine ? text.replace(/\s*\n+\s*/g, " ") : text;
  t = t.trim();
  const start = Math.max(0, Math.min(selStart, value.length));
  const end = Math.max(start, Math.min(selEnd, value.length));
  if (!t) return { value, caret: start };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  const inserted = lead + t + trail;
  return { value: before + inserted + after, caret: start + inserted.length };
}

export function insertAtCursor(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const single = el instanceof HTMLInputElement;
  const { value, caret } = computeInsertion(
    el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, text, { singleLine: single },
  );
  const proto = single ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch { /* type non sélectionnable */ }
}
