# content-studio (nom provisoire)

Studio de contenu open source (AGPL-3.0). Une idée entre, elle ressort déclinée
par canal, persona et direction artistique — écrite par TON agent IA (Claude
Code ou autre) connecté en MCP. L'outil n'appelle jamais de modèle : ton
abonnement IA travaille, l'outil orchestre.

## Self-host

    git clone <repo> && cd content-studio
    BETTER_AUTH_SECRET=$(openssl rand -hex 32) docker compose up -d --build
    # http://localhost:3003 → créer un compte (workspace + 3 canaux créés automatiquement)

## Dev

    docker compose up -d postgres
    cp .env.example .env.local        # éditer BETTER_AUTH_SECRET
    npm i && npm run db:migrate && npm run dev

## Brancher ton agent (MCP)

1. UI → Tokens MCP → Créer (le token n'est montré qu'une fois)
2. `claude mcp add --transport http content-studio http://localhost:3003/api/mcp --header "Authorization: Bearer cs_…"`
3. Dans ta session : « lis mes idées et décline la première en post communauté »

Outils exposés : list_ideas, get_idea, list_channels, list_personas,
get_art_direction, create_content_draft, get_content, update_content,
register_asset (v1.1).

Pendant que tu édites dans l'UI, une écriture de l'agent devient une
« proposition » avec diff à accepter — jamais d'écrasement silencieux.

## Extension Chrome (clipper)

Une page ou une sélection de texte → une idée + une source dans l'inbox, en un clic. MV3, vanilla JS, zéro build.

### Installation (mode développeur)

1. `chrome://extensions` → activer **Mode développeur** (en haut à droite)
2. **Charger l'extension non empaquetée** → sélectionner le dossier `extension/` de ce repo
3. Épingler l'icône (facultatif) pour l'avoir dans la barre d'outils

### Configuration

1. Cliquer sur l'icône de l'extension → popup
2. Renseigner l'**URL de l'instance** (ex. `http://localhost:3003`) et le **token MCP** (`cs_…`,
   généré via UI → Réglages → Tokens MCP)
3. **Enregistrer** — une permission d'accès à cette origine est demandée à ce moment précis
   (`chrome.permissions.request`, cf. « Choix technique » ci-dessous). Accepter la demande.

### Usage

- **Bouton popup « Clipper cette page »** : envoie l'URL + le titre de l'onglet actif, et le texte
  sélectionné s'il y en a un (lu via `chrome.scripting.executeScript`)
- **Menu contextuel « Clipper la sélection »** : sélectionner du texte sur n'importe quelle page →
  clic droit → « Clipper la sélection ». Un badge ✓ (succès) ou ✗ (échec) s'affiche 3s sur l'icône
- Le popup affiche l'état : succès avec lien direct vers l'idée (`/ideas/<id>`), ou erreur lisible
  (« Token invalide », « Instance injoignable », etc.)

### Choix technique : permissions minimales, pas de `host_permissions` large

Le manifest ne déclare que `activeTab`, `scripting`, `storage`, `contextMenus` — jamais un
`host_permissions` couvrant tout le web. Le `fetch` cross-origin vers l'instance configurée
(depuis le popup et le service worker) est rendu possible par `optional_host_permissions`
(`http://*/*`, `https://*/*`) demandée à la volée **uniquement** au moment où l'utilisateur
enregistre l'URL de SON instance — jamais au chargement de l'extension.

Filet de secours côté serveur : si la permission est refusée (ou pour tout appel qui déclenche
quand même un preflight), `src/app/api/clip/route.ts` répond aux requêtes `OPTIONS` et pose
`Access-Control-Allow-*` sur ses réponses, mais **seulement** quand l'`Origin` commence par
`chrome-extension://` — jamais un `Access-Control-Allow-Origin: *`, le reste de l'app reste
same-origin only.

### Limite connue de la vérification automatisée

Chrome a retiré le flag `--load-extension` des builds Chrome (branded) sur canal stable — un
unpacked ne peut plus être chargé en ligne de commande pour un test scripté classique. La
commande CDP `Extensions.loadUnpacked` existe mais charge l'extension dans un contexte isolé
de l'automatisation, invisible depuis une fenêtre normale (`chrome-extension://<id>/...` répond
`net::ERR_BLOCKED_BY_CLIENT` hors de ce contexte) — piloter le vrai popup via CDP n'est donc pas
possible dans cet environnement. La vérification réelle effectuée : le POST exact de `clip.js`
(mêmes headers/body) rejoué en Node contre le serveur de dev réel avec un token réel a créé une
idée + source vérifiées en base ; l'installation manuelle (`chrome://extensions` → mode
développeur → charger l'extension non empaquetée) reste à faire une fois par l'utilisateur pour
valider le popup et le menu contextuel eux-mêmes.

## Tests

    npm run test    # vitest single-run, db content_studio_test

## Limites connues (v1)

- Le Dockerfile self-host copie `.next` + `node_modules` en entier (pas de
  `output: "standalone"` dans `next.config.ts`) : image plus grosse que
  nécessaire, assumé pour rester simple en v1.
