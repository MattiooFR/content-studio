# Vague « cockpit » — spécification de conception

**Date** : 2026-08-07
**Statut** : en relecture
**Périmètre** : 5 features validées, ordonnées en 4 phases. Chaque phase livre seule.
La v1.1 « visuels sous DA » du plan initial passe APRÈS cette vague (décision produit).

Inspiration assumée : les cockpits d'opérateurs pilotés par agent (pattern
« l'agent écrit dans le dashboard, l'humain arbitre »). Tout reste fidèle au
principe fondateur : **l'outil n'appelle jamais de modèle** — l'extraction,
l'analyse et la rédaction viennent de l'agent de l'utilisateur.

---

## Phase A — Sources : le drop-anything (+ extension Chrome)

### A.1 Sources sur une idée

Une `idea` accepte des **sources** : URL, PDF, audio/vidéo, texte brut. L'outil
STOCKE ; l'agent EXTRAIT (transcript, texte, contenu de page) via ses propres
outils, puis rattache l'extraction. Le cycle :

```
humain/extension dépose  →  source (status: pending)
agent (MCP) liste les pending  →  extrait  →  attach_extraction  →  status: extracted
l'extraction devient la matière première des contenus de l'idée
```

**Table** :

```
sources   id, workspace_id, idea_id, kind ('url'|'pdf'|'audio'|'video'|'text'),
          ref (URL ou storage_key), title, raw_excerpt (texte court fourni au dépôt),
          extracted_text (texte long, rempli par l'agent), extracted_meta jsonb,
          status ('pending'|'extracted'|'failed'), created_by, timestamps
```

Upload binaire (PDF/audio) : réutilise la table `assets` + URL signée (le
pipeline prévu en v1.1 initiale) ; en attendant le storage S3, v1 de la phase =
`url` et `text` seulement, `pdf/audio` dès que `register_asset` est réel.

**MCP** (ajouts) : `list_sources(status?)`, `get_source(id)`,
`add_source(idea_id, kind, ref, title?, raw_excerpt?)`,
`attach_extraction(source_id, extracted_text, extracted_meta?)`.
`get_idea` inclut désormais le résumé des sources.

**UI** : zone de dépôt sur la page idée (URL ou texte collé) + liste des
sources avec statut ; l'inbox affiche le compte de sources par idée.

### A.2 Extension Chrome (clipper)

MV3, minimale, dans le repo (`extension/`). Popup : le token de workspace
(collé une fois, stocké en `chrome.storage.local`) + l'URL de l'instance.
Action : clipper la page courante (URL + titre + sélection éventuelle comme
`raw_excerpt`) → `POST /api/clip` → crée une `idea` (titre = titre de page,
statut inbox) AVEC sa source `url` en une requête. Menu contextuel « Clipper
la sélection » en bonus.

**Route** : `POST /api/clip` — auth par token MCP (Bearer, même mécanique que
`/api/mcp`), body `{ url, title, selection? }`. Pas de session navigateur :
le token est le bon niveau (l'extension est un client comme l'agent).

## Phase B — Funnel en une ligne + quality gate

Sur l'inbox (et en tête de page idée), une ligne par canal actif :

```
Communauté : 12 idées → 8 drafts → 3 en review → 5 publiés · 2 refusés
```

« Refusés » = un nouveau statut de contenu `rejected` (ajouté à l'enum), posé
par l'humain (bouton) ou l'agent — les refus sont VISIBLES, c'est la preuve
que la barre de qualité existe. Une requête agrégée
(`GET /api/stats/funnel`), un composant. Un indicateur « aucun goulot » /
« goulot : N contenus en review depuis > 7 j » calculé côté serveur (règle
simple, pas de modèle).

## Phase C — Jauges d'abonnements multi-comptes + tuile coût

Le header affiche l'état des abonnements IA de l'utilisateur — ceux que SES
agents consomment. L'outil ne connaît aucun provider : il **interroge des
endpoints configurés** par l'utilisateur.

**Table** :

```
gauge_sources  id, workspace_id, name, url, headers jsonb (chiffré app-level si SaaS),
               kind ('quota'|'cost'), enabled, last_payload jsonb, last_fetched_at
```

**Contrat de payload** (documenté README, volontairement minimal) :

```json
{ "accounts": [ { "id": "compte-1", "usedPercent": 87, "resetAt": "…",
                  "available": true } ], "costMonthlyEur": 378 }
```

Le serveur polle (intervalle 5 min, timeout court, échec = jauge grise
« injoignable », jamais d'erreur bloquante). Multi-comptes natif : chaque
entrée `accounts[]` devient un segment de jauge — le pool de comptes d'un
bridge local (ex. un `/health` qui expose `accounts[]`) s'affiche tel quel.
Tuile **coût mensuel** : somme des `costMonthlyEur` des sources `cost` +
champ manuel d'appoint (« autres outils : N €/mo »).

## Phase D — Lanes de chat embarquées (self-host d'abord)

Le pattern validé : des onglets de conversation agent DANS l'outil, à côté du
contenu. **Contrainte architecturale** : en self-host, l'app tourne sur la
machine de l'utilisateur → le serveur PEUT lancer le CLI local (`claude` en
mode non interactif / Agent SDK), c'est son abonnement, zéro inférence pour
l'outil. En SaaS, le serveur ne peut pas : les lanes exigeront un compagnon
local (hors périmètre de cette vague, documenté comme limite).

- `chat_lanes` (id, workspace_id, title, status, created_at) +
  `chat_messages` (lane_id, role, body, created_at).
- Le serveur spawne UNE session CLI par lane (process long ou reprise par
  `--resume`), streame la sortie via le SSE existant (`type:
  "lane.message"`).
- L'input permanent supporte `@` : référencer une idée/un contenu insère son
  contexte (id + titre + corps) dans le message.
- Bouton « chat » sur chaque contenu = ouvre une lane pré-contextualisée.
- Config : la commande du CLI est dans les réglages du workspace
  (`claude -p …` par défaut), jamais en dur.

Lien avec « Resume conv » (validé « why not ») : chaque révision d'agent créée
pendant qu'une lane est active porte `lane_id` dans `author_label` — le
panneau révisions affiche « ouvrir la conversation » quand il est présent.
C'est tout ce qu'on prend du pattern inbox pour l'instant ; l'inbox complète
de findings ([Fix it]/[Ask]/[Done]) reste HORS périmètre de cette vague.

## Ordre, dépendances, tests

| Phase | Dépend de | Cœur de tests |
|---|---|---|
| A | rien | cycle pending→extracted via MCP ; /api/clip auth token + création idée+source ; cloisonnement workspace |
| B | statut `rejected` | agrégat funnel exact sur fixture ; règle de goulot |
| C | rien | poller : payload conforme/malformé/timeout ; multi-comptes rendu ; jamais bloquant |
| D | SSE existant | lane spawn/stream/stop ; @-référence ; révision porteuse de lane_id |

Chaque phase = spec de tests d'abord, mêmes conventions que la v1 (vitest
single-run, cloisonnement systématique, allow-list des écritures, res.ok +
échec visible, 401 TenantError).

## Hors périmètre de cette vague

Inbox de findings avec [Fix it], visuels sous DA (redeviennent la vague
suivante), compagnon local SaaS pour les lanes, extraction côté serveur
(JAMAIS : c'est le travail de l'agent), Firefox/Safari pour l'extension.
