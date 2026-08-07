// background.js — service worker MV3.
//
// Un seul rôle en plus du popup : le menu contextuel "Clipper la sélection"
// (contexts: ["selection"]) qui pose le même POST /api/clip que le popup,
// avec la config lue dans chrome.storage.local. Pas de notification — un
// badge d'action ✓/✗ 3s suffit (chrome.action ne demande aucune permission
// supplémentaire, contrairement à chrome.notifications).

importScripts("clip.js");

const MENU_ID = "content-studio-clip-selection";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Clipper la sélection",
    contexts: ["selection"],
  });
});

function flashBadge(tabId, ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? "#3dd68c" : "#ff5d5d", tabId });
  chrome.action.setBadgeText({ text: ok ? "✓" : "✗", tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId });
  }, 3000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) return;

  const { instanceUrl, token } = await chrome.storage.local.get(["instanceUrl", "token"]);
  if (!instanceUrl || !token) {
    flashBadge(tab.id, false);
    return;
  }

  const pageUrl = info.pageUrl || tab.url || "";
  const outcome = await csClipRequest(
    { instanceUrl, token },
    {
      url: pageUrl,
      title: tab.title || pageUrl,
      selection: info.selectionText || "",
    }
  );

  flashBadge(tab.id, outcome.ok);
});
