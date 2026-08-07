// clip.js — logique POST /api/clip partagée entre popup.js et background.js.
//
// Script CLASSIQUE (pas de import/export ES module) : chargé via <script src>
// dans popup.html ET via importScripts() dans le service worker MV3. Les deux
// contextes exposent `fetch` et `URL` globalement, donc une simple fonction
// globale suffit — pas besoin d'un bundler pour une extension aussi petite.

/**
 * Envoie {url, title, selection} à POST <instanceUrl>/api/clip avec le token
 * Bearer configuré. Ne lève jamais : rend toujours un objet discriminé par
 * `ok`, avec un `kind` d'erreur pour que l'appelant affiche le bon message.
 */
async function csClipRequest(config, payload) {
  const instanceUrl = (config && config.instanceUrl) || "";
  const token = (config && config.token) || "";

  if (!instanceUrl || !token) {
    return { ok: false, kind: "config", message: "Configure d'abord l'URL et le token." };
  }

  let endpoint;
  try {
    endpoint = new URL("/api/clip", instanceUrl).toString();
  } catch {
    return { ok: false, kind: "config", message: "URL d'instance invalide." };
  }

  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // fetch rejette sur erreur réseau (DNS, refus de connexion, CORS bloqué…)
    return { ok: false, kind: "network", message: "Instance injoignable." };
  }

  if (res.status === 401) {
    return { ok: false, kind: "auth", message: "Token invalide." };
  }

  if (!res.ok) {
    let message = `Erreur serveur (${res.status}).`;
    try {
      const data = await res.json();
      if (data && typeof data.error === "string") message = data.error;
    } catch {
      // corps non-JSON : on garde le message générique
    }
    return { ok: false, kind: "server", message };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, kind: "server", message: "Réponse serveur illisible." };
  }

  return { ok: true, ideaId: data.ideaId, sourceId: data.sourceId };
}
