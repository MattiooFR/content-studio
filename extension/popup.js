// popup.js — UI du popup : configuration (URL d'instance + token) et clip de
// l'onglet actif (page entière ou sélection).

const $instanceUrl = document.getElementById("instanceUrl");
const $token = document.getElementById("token");
const $save = document.getElementById("save");
const $clip = document.getElementById("clip");
const $status = document.getElementById("status");

// `content` est soit une string (affichée en texte brut), soit un Node déjà
// construit (cas du lien de succès). Jamais de innerHTML : `ideaId` vient du
// serveur configuré par l'utilisateur — un serveur malicieux ou mal
// configuré ne doit pas pouvoir injecter du HTML exécutable dans le popup.
function showStatus(kind, content) {
  $status.className = `status show ${kind}`;
  $status.replaceChildren();
  if (typeof content === "string") {
    $status.textContent = content;
  } else {
    $status.appendChild(content);
  }
}

function clearStatus() {
  $status.className = "status";
  $status.replaceChildren();
}

async function loadConfig() {
  const { instanceUrl, token } = await chrome.storage.local.get(["instanceUrl", "token"]);
  if (instanceUrl) $instanceUrl.value = instanceUrl;
  if (token) $token.value = token;
}

$save.addEventListener("click", async () => {
  clearStatus();
  const rawUrl = $instanceUrl.value.trim();
  const token = $token.value.trim();

  if (!rawUrl || !token) {
    showStatus("err", "URL et token requis.");
    return;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    showStatus("err", "URL d'instance invalide.");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    showStatus("err", "URL d'instance invalide (http/https attendu).");
    return;
  }

  // Permission hôte demandée à la volée, MAINTENANT — pas de host_permissions
  // large déclarée dans le manifest. `optional_host_permissions` couvre
  // http(s)://*/* ; on ne demande que l'origine exacte de CETTE instance.
  const originPattern = `${parsed.origin}/*`;
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [originPattern] });
  } catch {
    granted = false;
  }

  await chrome.storage.local.set({ instanceUrl: parsed.origin, token });

  if (granted) {
    showStatus("ok", "Configuration enregistrée.");
  } else {
    showStatus(
      "err",
      "Configuration enregistrée, mais la permission d'accès à cette origine a été refusée : le clip peut échouer si l'instance ne l'autorise pas elle-même (CORS)."
    );
  }
});

$clip.addEventListener("click", async () => {
  clearStatus();
  $clip.disabled = true;
  try {
    const { instanceUrl, token } = await chrome.storage.local.get(["instanceUrl", "token"]);
    if (!instanceUrl || !token) {
      showStatus("err", "Configure d'abord l'URL et le token.");
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) {
      showStatus("err", "Cette page ne peut pas être clippée.");
      return;
    }

    let selection = "";
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const s = window.getSelection();
          return s ? s.toString() : "";
        },
      });
      selection = (results && results[0] && results[0].result) || "";
    } catch {
      // Page restreinte (webstore, PDF viewer…) : on clippe quand même, sans sélection.
    }

    const outcome = await csClipRequest(
      { instanceUrl, token },
      { url: tab.url, title: tab.title || tab.url, selection }
    );

    if (outcome.ok) {
      const ideaUrl = new URL(`/ideas/${outcome.ideaId}`, instanceUrl).toString();
      const frag = document.createDocumentFragment();
      frag.appendChild(document.createTextNode("Clippé → "));
      const link = document.createElement("a");
      link.href = ideaUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "ouvre l'idée";
      frag.appendChild(link);
      showStatus("ok", frag);
    } else {
      showStatus("err", outcome.message);
    }
  } finally {
    $clip.disabled = false;
  }
});

loadConfig();
