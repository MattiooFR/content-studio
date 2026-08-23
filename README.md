# content-studio (nom provisoire)

Studio de contenu open source (AGPL-3.0). Une idée entre, elle ressort déclinée
par canal, persona et direction artistique — écrite par TON agent IA (Claude
Code ou autre) connecté en MCP. L'outil n'appelle jamais de modèle : ton
abonnement IA travaille, l'outil orchestre.

## Self-host

    git clone <repo> && cd content-studio
    BETTER_AUTH_SECRET=$(openssl rand -hex 32) docker compose up -d --build
    # http://localhost:3003 → créer un compte (workspace + 3 canaux créés automatiquement)

## Sécurité / déploiement

**Par défaut, l'app n'écoute QUE sur `127.0.0.1`** — `npm run dev` et `npm run start`
(exécution bare, hors Docker) bindent explicitement le loopback. Un déploiement via
`docker compose` reste identique à l'usage (le conteneur écoute en interne sur toutes ses
interfaces, requis par le NAT de publication de port de Docker) mais le port publié côté
hôte, `docker-compose.yml`, est lui aussi restreint à `127.0.0.1:3003:3003` — même schéma que
`postgres` juste au-dessus dans le même fichier. Dans les deux cas, l'app est injoignable
depuis le réseau/internet tant qu'aucune étape supplémentaire n'a été prise.

**Exposer l'instance au-delà de ta propre machine = deux étapes, en conscience :**

1. Un reverse-proxy (nginx, Caddy, Traefik…) devant `127.0.0.1:3003`, avec TLS. Ne jamais
   remapper le port Docker sur `0.0.0.0` directement.
2. `DISABLE_SIGNUP=1` (ou `true`) dans l'environnement, **une fois ton compte owner créé**.
   Signup reste ouvert par défaut (pratique en dev local mono-utilisateur) : combiné à un port
   joignable, un signup ouvert permet à n'importe qui de créer un workspace puis de
   configurer `laneCommand` (Réglages → Lanes) — voir l'avertissement ci-dessous, c'est
   l'exécution de commande à distance. Le tout premier compte créé sur une base encore vide
   reste toujours autorisé, même `DISABLE_SIGNUP=1` posé avant le premier démarrage
   (bootstrap : impossible sinon de créer le compte owner lui-même).

**Rappel qui vaut pour toute la section Lanes ci-dessous : les lanes exécutent des commandes
sur l'hôte qui fait tourner le serveur.** Sur cette version, self-host, l'accès à l'instance
(un compte + un token, ou une session) EST un accès shell à cette machine, au travers de
`laneCommand`. Ce n'est pas un bug à corriger plus tard, c'est l'architecture (cf. section
Lanes, « Self-host uniquement ») — raison de plus pour ne jamais exposer une instance en
signup ouvert.

## Dev

    docker compose up -d postgres
    cp .env.example .env.local        # éditer BETTER_AUTH_SECRET
    npm i && npm run db:migrate && npm run dev

## Brancher ton agent (MCP)

1. UI → Tokens MCP → Créer (le token n'est montré qu'une fois)
2. `claude mcp add --transport http content-studio http://localhost:3003/api/mcp --header "Authorization: Bearer cs_…"`
3. Dans ta session : « lis mes idées et décline la première en post communauté »

Outils exposés (26) :
- **Idées & contenu** : list_ideas, create_idea, get_idea, list_channels, list_personas,
  get_art_direction, create_content_draft, get_content, update_content.
- **Sources** : list_sources, get_source, add_source, attach_extraction, register_asset
  (réservé v1.1 — v1 est texte uniquement).
- **Relecture** : list_comments, resolve_comment.
- **Jobs** (worker externe, détail juste en dessous) : list_jobs, claim_job,
  heartbeat_job, complete_job, fail_job, set_content_status, update_idea.
- **Publications** : list_publications, link_publication, mark_synced.

Pendant que tu édites dans l'UI, une écriture de l'agent devient une
« proposition » avec diff à accepter — jamais d'écrasement silencieux.

## Un worker externe : jobs, publications, relecture

Trois briques qui font de l'outil le poste de pilotage d'un worker externe, connecté en
MCP — l'outil n'appelle jamais de modèle et ne publie jamais lui-même.

### Le modèle

L'UI pose des **jobs** (bouton « Rédiger », « Publier », « Appliquer les commentaires »,
ou le hook de re-synchronisation). Un worker branché en MCP tourne en boucle :
`list_jobs({status: "queued"})` → `claim_job` (atomique : un seul worker gagne) → il
travaille → `complete_job` ou `fail_job`. Sur un travail long, `heartbeat_job` toutes les
60 secondes — sans battement pendant 10 minutes, le job repasse automatiquement `failed`
(« agent silencieux »), ça libère la cible pour un nouveau job.

**Un workspace sans worker branché voit simplement ses jobs rester « en attente d'un
agent ».** Rien ne bloque, rien ne timeout côté UI — l'humain garde la main pour relancer
depuis les boutons.

**Pas de réessai automatique.** Un job `failed` reste `failed` : c'est le bouton
« Réessayer » de l'UI (`POST /api/jobs/:id/retry`) qui le repasse `queued`, jamais un
retry silencieux côté serveur.

### Les kinds intégrés

| kind | à la création (UI) | à la complétion |
|---|---|---|
| `write` | idée → `in_progress` | worker pose `set_content_status(review)` |
| `publish` | contenu → `approved` (corps non vide requis) | worker pose `link_publication` + `set_content_status(published)` |
| `sync` | jamais par un bouton direct — créé par le hook de re-sync, ou par « Re-synchroniser » sur la carte publication | worker pose `mark_synced` |
| `revise` | rien | worker `list_comments(open)` → réécrit → `update_content` → `resolve_comment(applied)` |
| `transcribe` | jamais par un bouton — créé par la route de dictée | seule complétion qui écrit ailleurs que dans le job : `result.text` devient le corps du commentaire |

Tout autre `kind` est libre : l'outil l'accepte, le range dans la file, et laisse le
worker et l'UI convenir de son sens (pastille générique, pas d'effet automatique).

### Publications

Après une publication réussie, le worker appelle `link_publication(content_id, target,
external_id, url?, meta?, body_hash)` — upsert sur (contenu, cible). La page contenu
affiche alors une carte « Publication » avec lien vers l'externe et statut de fraîcheur.

**Hook « publié puis modifié »** : dès qu'une révision devient la version courante d'un
contenu déjà publié, si son hash diffère du corps publié, un job `sync` est posé
automatiquement (coalescé — un seul `sync` en attente par publication, via
`dedupe_key` dans le payload). Le worker republie le corps courant puis appelle
`mark_synced(publication_id, body_hash)`, qui efface `last_error`.

### Relecture

Onglet **Relire** sur la page contenu : l'humain surligne un passage, écrit une remarque
ou la dicte. Le worker lit `list_comments({status: "open"})` — chaque entrée porte
`quote`/`prefix`/`suffix` (ancrage), `body`, et `position` déjà recalculée sur le markdown
courant — réécrit uniquement les passages visés, puis `resolve_comment(comment_id,
{status: "applied"})`.

**Divergence d'ancrage à connaître** : `quote`/`prefix`/`suffix` proviennent du texte
**rendu** (sans marqueurs markdown), alors que `position` est recalculée sur le
**markdown source** — elle peut être `null` (passage formaté, ou à cheval sur deux blocs)
ou une **première occurrence** (`level: 3`). Toujours vérifier `position.level` (1 = exact,
2 = normalisé, 3 = quote seule) avant de réécrire à l'offset ; en cas de doute, retrouver
le passage par la `quote` plutôt que par `start`/`end`.

Une remarque dictée part en `POST /api/contents/:id/comments/audio`, qui crée le
commentaire et un job `transcribe` sur cette cible. Le worker récupère l'audio par
**la seule route REST binaire ouverte au token MCP** :

    GET /api/jobs/:id/audio
    Authorization: Bearer cs_…

Elle rend l'audio brut (content-type = mime d'origine) si et seulement si le job, dans le
workspace du token, est un `transcribe` ciblant un commentaire — 404 sinon (job d'un autre
workspace, mauvais kind, audio déjà purgé après transcription). Le worker transcrit, puis
`complete_job(job_id, {result: {text: "..."}})` — l'outil bascule lui-même le commentaire
en `body = text`, `transcription: "done"`.

### Squelette de worker

```js
// worker.mjs — sonde le studio toutes les 30 s, un job à la fois (client MCP = @modelcontextprotocol/sdk)
const tool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
while (true) {
  const [job] = await tool("list_jobs", { status: "queued" });
  if (!job) { await sleep(30_000); continue; }
  const claimed = await tool("claim_job", { job_id: job.id, worker_label: "mon-worker" });
  if (claimed.error) continue;                       // un autre worker l'a pris
  const hb = setInterval(() => tool("heartbeat_job", { job_id: job.id }), 60_000);
  try {
    switch (job.kind) {
      case "write":      /* enquête + rédaction → create_content_draft, update_content, set_content_status(review) */ break;
      case "publish":    /* POST vers ta cible → link_publication, set_content_status(published), update_idea(done) */ break;
      case "sync":       /* re-publie le corps courant → mark_synced */ break;
      case "revise":     /* list_comments(open) → réécrit → update_content → resolve_comment(applied) */ break;
      case "transcribe": /* GET /api/jobs/:id/audio (Bearer) → whisper → complete_job({ text }) */ break;
      default:           throw new Error(`kind inconnu : ${job.kind}`);
    }
    await tool("complete_job", { job_id: job.id, result: { /* … */ } });
  } catch (e) {
    await tool("fail_job", { job_id: job.id, error: String(e.message).slice(0, 2000) });
  } finally { clearInterval(hb); }
}
```

### Sécurité et bornes

Aucune exécution côté serveur ici (contrairement aux Lanes, ci-dessous) : jobs,
publications et commentaires ne sont que des lignes en base, un worker externe fait tout
le travail. `GET /api/jobs/:id/audio` est la seule route REST binaire ouverte au token
MCP — tout le reste passe par les outils MCP JSON ci-dessus, bornés au workspace du token.

Bornes fixes, mêmes pour l'UI et pour MCP : message d'erreur de job 2000 caractères,
payload et result de job 64 Ko chacun, audio de commentaire 16 Mo, citation (quote)
2000 caractères, corps de commentaire 10 000 caractères.

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
`127.0.0.0/8`, `10.*`, `192.168.*`, `169.254.*`, `172.16.0.0/12` (172.16.\* à 172.31.\*),
`100.64.0.0/10` (100.64.\* à 100.127.\*, plage CGNAT) et `0.0.0.0` écrits en clair dans l'URL
sont refusés à la création — mais cette liste ne couvre QUE les adresses IP littérales : elle
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
- **Cap anti-DoS : 2 MiB, sur stdout ET stderr indépendamment.** Un CLI qui inonde l'un ou
  l'autre flux est coupé — la LECTURE s'arrête au cap, pas seulement un kill demandé : même
  un process qui ignore SIGTERM pendant toute la fenêtre de grâce ne fait pas grossir le
  buffer au-delà.
- Le verrou (une seule exécution à la fois par lane, 409 sur un 2e message concurrent) est
  TOUJOURS relâché en sortie, quel que soit le chemin (succès, erreur CLI, timeout, cap
  dépassé).

## Tests

    npm run test    # vitest single-run, db content_studio_test

## Limites connues (v1)

- Le Dockerfile self-host copie `.next` + `node_modules` en entier (pas de
  `output: "standalone"` dans `next.config.ts`) : image plus grosse que
  nécessaire, assumé pour rester simple en v1.
