import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { isSupportedAudioMime, readBodyBounded, MAX_AUDIO_BYTES, AUDIO_MIMES } from "@/lib/audio";

const post = (body: BodyInit | null) =>
  new NextRequest("http://localhost:3003/api/x", { method: "POST", body, headers: { "content-type": "audio/webm" } });

describe("lib/audio — bornes partagées", () => {
  it("isSupportedAudioMime ignore les paramètres et refuse l'inconnu", () => {
    expect(isSupportedAudioMime("audio/webm;codecs=opus")).toBe(true);
    expect(isSupportedAudioMime("audio/mp4")).toBe(true);
    expect(isSupportedAudioMime("text/plain")).toBe(false);
    expect(AUDIO_MIMES.length).toBeGreaterThan(0);
    expect(MAX_AUDIO_BYTES).toBe(16 * 1024 * 1024);
  });

  it("readBodyBounded : sous la borne → Buffer, au-delà → null, sans corps → vide", async () => {
    expect((await readBodyBounded(post("x".repeat(10)), 10))?.length).toBe(10);
    expect(await readBodyBounded(post("x".repeat(11)), 10)).toBeNull();
    expect((await readBodyBounded(post(null), 10))?.length).toBe(0);
  });
});
