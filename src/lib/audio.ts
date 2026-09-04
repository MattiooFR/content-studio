import type { NextRequest } from "next/server";

// Bornes audio PARTAGÉES par la dictée des commentaires (legacy) et la dictée
// des champs (vague « dictée partout ») : une seule règle, un seul endroit.
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
export const AUDIO_MIMES = ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"];

/** Compare sur le type sans paramètres : `audio/webm;codecs=opus` → `audio/webm`. */
export function isSupportedAudioMime(mime: string): boolean {
  const base = mime.split(";")[0].trim();
  return AUDIO_MIMES.some((m) => m.split(";")[0] === base);
}

/**
 * Lit le corps par morceaux et coupe DÈS que le cumul dépasse `max`, sans
 * jamais tamponner plus que max + un chunk : un upload chunké/streamé sans
 * (ou avec un) content-length mensonger ne doit pas forcer à bufferiser tout
 * le flux avant de le rejeter (mémoire non bornée sinon). null = dépassement
 * (→ 413 côté appelant) ; corps absent = vide (→ "audio vide" côté lib, 400).
 */
export async function readBodyBounded(req: NextRequest, max: number): Promise<Buffer | null> {
  const body = req.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
