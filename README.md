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

## Jauges (abonnements IA multi-comptes)

Le header affiche l'état des abonnements IA que TES agents consomment. L'outil n'appelle
jamais de modèle et ne connaît aucun provider : il **interroge des endpoints que tu
configures toi-même** (`Réglages → Jauges`), rien d'autre.

### Contrat de payload

Chaque source répond en JSON, sur ce contrat (documenté ici, volontairement minimal) :

```json
{
  "accounts": [
    { "id": "compte-1", "usedPercent": 87, "resetAt": "2026-08-10T00:00:00Z", "available": true },
    { "id": "compte-2", "usedPercent": 12, "resetAt": "2026-08-12T00:00:00Z", "available": true }
  ],
  "costMonthlyEur": 378
}
```

- `accounts[]` (optionnel, 50 entrées max) — un `id` (obligatoire), `usedPercent` (0–100),
  `resetAt` (chaîne parseable en date, ex. ISO 8601 — un format non parseable n'affiche
  simplement pas de date, jamais d'erreur) et `available` (booléen), tous optionnels sauf `id`.
- `costMonthlyEur` (optionnel, nombre) : coût mensuel de CETTE source.

**Multi-comptes natif** : chaque entrée de `accounts[]` devient un segment de jauge séparé —
un `/health` de bridge local qui expose plusieurs comptes en pool (ex. un pool round-robin de
clés) s'affiche tel quel, un segment par compte. Le chiffre affiché à côté de la barre est le
compte disponible le plus consommé (celui qui bloque en premier) ; un compte `available:
false` s'affiche hachuré et sort du calcul.

La tuile **Coût / mois** du header additionne les `costMonthlyEur` de toutes les sources
`kind: "cost"` activées.

Un payload qui ne respecte pas ce contrat (mauvais type, `usedPercent` hors [0,100], plus de
50 comptes, champ requis absent…) est un échec de parsing : la source passe grise
(« injoignable », erreur visible au survol), jamais une erreur bloquante pour le reste du
cockpit. Champs inconnus dans le payload : ignorés, pas rejetés.

### `kind`

- `quota` : source de comptes/segments de jauge.
- `cost` : source de coût mensuel (n'affiche pas de segments, seulement `costMonthlyEur`).

### Polling

Le serveur interroge chaque source activée à l'affichage de la page, avec un cache de 5
minutes (timeout réseau : 4 s) — pas de cron, pas de polling en tâche de fond. Le header
rafraîchit lui-même toutes les 5 minutes, plus un bouton manuel (↻).

### `localhost` autorisé — la vraie protection SaaS est l'egress réseau

En self-host, les bridges locaux de l'utilisateur SONT le cas d'usage : `localhost`,
`127.0.0.1` et `[::1]` sont explicitement autorisés comme cible de jauge. Le reste de
`127.0.0.0/8`, `10.*`, `192.168.*`, `169.254.*` et `0.0.0.0` écrits en clair dans l'URL sont
refusés à la création — mais cette liste ne couvre QUE les adresses IP littérales : elle
n'empêche pas un nom d'hôte qui résout vers une IP privée (DNS rebinding). **Ce n'est pas la
protection réelle d'un déploiement SaaS multi-tenant** — celle-là est le firewall d'egress
réseau du déploiement, pas cette validation applicative côté app. Aucune redirection (3xx)
n'est suivie non plus : un endpoint approuvé à la création qui répondrait plus tard par un 302
vers une cible interne, header custom embarqué, ne fait rien passer.

## Lanes (conversations agent — self-host uniquement)

Un onglet de conversation avec TON CLI agent local, directement dans l'outil, à côté du
contenu (bouton « 💬 Chat » sur une page contenu, ou l'icône du header). `@` dans l'input
référence une idée ou un contenu existant : la sélection insère son contexte (titre + corps,
tronqué à 2000 caractères) dans le message envoyé au CLI. Chaque révision écrite par l'agent
PENDANT qu'une lane est active porte `lane:<id>` — le panneau révisions du contenu affiche
alors « ouvrir la conversation » dessus.

### Self-host uniquement

**Contrainte architecturale, pas un choix arbitraire.** En self-host, le serveur tourne sur TA
machine : il peut donc spawn ton CLI local (`claude -p`, `codex exec`…) — c'est ton abonnement
qui travaille, zéro inférence faite par l'outil lui-même. En SaaS, le serveur ne peut PAS faire
ça (spawn un process sur une machine qu'il ne possède pas) : les lanes y exigeraient un
compagnon local, hors périmètre de cette version.

### `laneCommand` — configurable, jamais en dur

`Réglages → Lanes` (`/settings/workspace`) expose un seul champ, `laneCommand`, par défaut
`claude -p --output-format stream-json --verbose`. Chaque tour de conversation spawn CETTE
commande, avec le message utilisateur en dernier argument positionnel (précédé de `--resume
<session_id>` dès la 2e conversation, si le CLI le supporte).

**Avertissement : cette commande tourne sur TA machine.** Le serveur ne fait que
l'orchestrer — il ne l'inspecte pas, ne la sandbox pas. Configurer `laneCommand` avec une
commande qu'on n'a pas écrite ou vérifiée soi-même revient à exécuter un process arbitraire
côté serveur, avec les droits du process serveur.

### Le séparateur `--` : un message n'est jamais un flag

Le message est toujours transmis après un `--` littéral (`[..., "--", message]`, ou
`["--resume", id, "--", message]` en reprise) — sans lui, un message commençant par `-` (ex.
`--dangerously-skip-permissions`) serait lu comme une OPTION par le parseur d'arguments du CLI
cible (commander.js et consorts), pas comme du texte. Le spawn passe aussi par `sh -c
'<laneCommand> "$@"' sh ...args` : la chaîne interprétée par le shell est FIGÉE (la commande
des réglages) + `"$@"` littéral — le message arrive en argv séparé, jamais concaténé dans du
texte exécuté par le shell, donc incapable d'en ouvrir une nouvelle commande.

### Timeout et cap

- **Timeout dur : 120 secondes.** Au-delà, l'arbre de process entier est tué (SIGTERM puis
  SIGKILL après 5 s de grâce si le premier signal est ignoré), la lane passe en statut `error`.
- **Cap stdout anti-DoS : 2 MiB.** Un CLI qui inonde sa sortie est coupé — la LECTURE s'arrête
  au cap, pas seulement un kill demandé : même un process qui ignore SIGTERM pendant toute la
  fenêtre de grâce ne fait pas grossir le buffer au-delà.
- Le verrou (une seule exécution à la fois par lane, 409 sur un 2e message concurrent) est
  TOUJOURS relâché en sortie, quel que soit le chemin (succès, erreur CLI, timeout, cap
  dépassé).

## Tests

    npm run test    # vitest single-run, db content_studio_test

## Limites connues (v1)

- Le Dockerfile self-host copie `.next` + `node_modules` en entier (pas de
  `output: "standalone"` dans `next.config.ts`) : image plus grosse que
  nécessaire, assumé pour rester simple en v1.
