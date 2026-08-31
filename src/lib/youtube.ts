// Détection YouTube PURE (aucun import) : partagée entre la lib sources
// (reclassement url → video), la route /api/clip, et le composant client de
// la fiche idée (badge « vidéo ») — d'où un module sans dépendance serveur.
const ID = /^[A-Za-z0-9_-]{6,20}$/;

/** L'id vidéo si ref est une URL YouTube reconnue, sinon null. */
export function youtubeVideoId(ref: string): string | null {
  let u: URL;
  try { u = new URL(ref); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return ID.test(id) ? id : null;
  }
  if (host === "youtube.com") {
    if (u.pathname === "/watch") {
      const id = u.searchParams.get("v") ?? "";
      return ID.test(id) ? id : null;
    }
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,20})(?:\/|$)/);
    return m ? m[1] : null;
  }
  return null;
}
