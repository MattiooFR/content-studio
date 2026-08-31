# Veille — propositions d'un worker de sourcing externe

**Date** : 2026-08-31
**Décision produit** : le studio gagne un module « Veille » générique — tables, outils
MCP, trois écrans — qu'un worker de veille externe alimente. Le studio n'appelle
toujours aucun modèle, aucune API externe, et n'a toujours aucun cron : le worker
collecte, score et adapte ; le studio consigne, cloisonne, notifie, et laisse
l'utilisateur décider. Rien dans ce module ne nomme un réseau social ni un
fournisseur : c'est « un post social », d'où qu'il vienne.

## 1. Problème

Un worker de veille surveille des comptes et des mots-clés, repère les posts qui
surperforment, en rédige des adaptations, et a besoin : d'un endroit où déposer ses
propositions et son corpus, d'un écran où l'utilisateur valide/refuse chaque matin,
d'un endroit où lire sa configuration (quoi surveiller, quel style), et d'un chemin
de publication. Aujourd'hui tout cela vit dans une application séparée ; on veut une
seule app.

## 2. Cible

- Le worker dépose des **items de veille** par MCP : des propositions scorées et
  adaptées (`proposed`), et le corpus brut exploré (`pool`).
- L'utilisateur traite la file du matin sur un écran dédié : côte à côte
  source/adaptation, éditer, **Valider** ou **Refuser** (motif + note).
- Valider fait entrer l'item dans le pipeline standard du studio : idée + source +
  contenu approuvé + job `publish` — le worker publie, `link_publication` referme la
  boucle. Le post validé apparaît dans le funnel, les publications et l'historique
  comme n'importe quel contenu.
- Les refus et leurs motifs restent lisibles par le worker (contre-exemples pour ses
  rédactions futures).
- La configuration de la veille (feeds, thèmes, style, cible de publication) s'édite
  dans les réglages du studio et se lit par MCP.

## 3. Schéma (migration 0007) — trois tables, `workspace_id NOT NULL` partout

### `watch_items`

| Colonne | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid NOT NULL → workspaces | |
| `external_id` | text NOT NULL | id du post chez sa plateforme ; **unique (workspace_id, external_id)** |
| `url` | text | lien vers le post source |
| `author` | jsonb | `{ name, handle, avatar_url, followers }` — champs facultatifs |
| `text_source` | text NOT NULL | texte du post source |
| `lang` | text | |
| `posted_at` | timestamptz | date du post source |
| `metrics` | jsonb NOT NULL default `{}` | compteurs libres posés par le worker (likes, partages, sauvegardes…) |
| `media` | jsonb | URLs d'images/vidéos du post |
| `visual` | jsonb | analyse du visuel par le worker : `{ type, description, reproducibility, how_to, text_read }` |
| `text_adapted` | text | l'adaptation proposée (absente sur un item `pool`) |
| `score` | numeric | posé par le worker ; sémantique à sa main |
| `status` | text NOT NULL | `pool` \| `proposed` \| `validated` \| `refused` \| `expired` |
| `refusal_reason` | text | motif de refus (liste proposée par l'UI, valeur libre au schéma) |
| `refusal_note` | text | ≤ 280 caractères |
| `publish_ref` | jsonb | lien de publication porté par l'item lui-même (historique importé) ; les validations neuves passent par `publications` |
| `idea_id` | uuid → ideas | posé à la validation (et par « Créer une idée » du radar) |
| `content_id` | uuid → contents | posé à la validation |
| `fetched_at` | timestamptz NOT NULL | |
| `decided_at` | timestamptz | |

Index : `(workspace_id, status, score desc)` et `(workspace_id, status, fetched_at)`.

### `watch_feeds`

`id`, `workspace_id NOT NULL`, `kind` `account`|`query`, `label` (handle ou mot-clé),
`params` jsonb default `{}` (cadence, langue, fenêtre… — interprétés par le worker),
`enabled` bool default true, `last_fetched_at`. Unique `(workspace_id, kind, label)`.

### `watch_settings` (PK `workspace_id`, jumeau de `workspace_settings`)

`topics text[]` default `{}`, `style text`, `require_media bool` default false,
`channel_key text` (le canal du workspace sur lequel les validations créent leur
contenu — requis pour valider), `publish_config jsonb` (config de la cible de
publication, interprétée par le worker), `updated_at`.

**`publish_config` est write-only côté navigateur** : les routes HTTP le stockent
mais ne le renvoient jamais — seuls les 4 derniers caractères d'une valeur sensible
sont affichés. Même triptyque de redaction (GET, POST, PATCH) que
`gauge_sources.headers`. Le MCP, lui, le lit en clair : c'est le canal du worker, et
le token MCP donne déjà accès aux secrets du workspace par construction.

## 4. Cycle de vie d'un item

```
worker ── upsert ──▶ pool ──「Créer une idée」──▶ (idea + source, item inchangé)
worker ── upsert ──▶ proposed ──┬─ Valider ──▶ validated  (+ idea + content approved + job publish)
                                ├─ Refuser ──▶ refused    (motif + note)
                                └─ > 7 jours ─▶ expired   (paresseux, à l'affichage)
```

- **Un item déjà décidé (`validated`/`refused`/`expired`) est immuable pour le
  worker** : `upsert_watch_items` l'ignore silencieusement. Un refus d'hier ne peut
  pas être re-proposé demain.
- **Valider** (`editedText` facultatif) : garde `status = proposed`, puis en une
  unité atomique — idée créée (titre dérivé de l'adaptation), source `url` attachée,
  contenu créé sur le canal `watch_settings.channel_key`, corps = texte final,
  statut `approved`, job `publish` posé, item passé `validated` avec `idea_id` /
  `content_id` / `decided_at`. Si une étape échoue, l'item reste `proposed`. Les
  events existants (`idea.created`, `job.updated`) rafraîchissent la sidebar sans
  plomberie nouvelle.
- **Expiration et purge, sans cron** (pattern `sweepSilentJobs`) : à l'affichage de
  la file, les `proposed` de plus de 7 jours passent `expired` ; à l'affichage du
  radar, les `pool` de plus de 14 jours sont supprimés. Les items décidés
  (`validated`, `refused`, `expired`) sont conservés (historique + contre-exemples).

## 5. Outils MCP (6, `registerTool` uniquement, scopés au workspace du token)

| Outil | Rôle |
|---|---|
| `get_watch_config` | feeds `enabled` + `watch_settings` complets, `publish_config` en clair |
| `upsert_watch_items(items[])` | dépôt idempotent sur `(workspace, external_id)`, statuts `pool`/`proposed` seulement ; items décidés ignorés |
| `list_watch_items({status?, since?, limit?})` | relire l'état — notamment les `refused` récents |
| `mark_feed_fetched(feed_id)` | horodate `last_fetched_at` |
| `upsert_watch_feed({kind, label, params?, enabled?})` | créer/modifier un feed (clé `kind`+`label`) |
| `update_watch_settings(partial)` | écrire les réglages, `publish_config` inclus |

Erreurs métier en `{ error: "…" }` JSON, conventions du repo (allow-list stricte des
champs écrits, 404/400/401).

## 6. UI

La veille n'est **pas un bucket** (les buckets sont des étapes dérivées des idées) :
c'est une section de nav propre dans la sidebar, avec un **badge** = nombre de
`proposed`, tenu à jour par l'event `watch.updated`.

- **`/watch` — la file du matin.** Items `proposed` triés par score décroissant.
  Carte côte à côte : source (auteur, avatar, compteurs, image, analyse `visual`) /
  adaptation éditable. Boutons **Valider** et **Refuser** (motifs proposés par une
  constante du module + note ≤ 280, les deux facultatifs). Sous la file, les
  dernières `validated` avec leur lien de publication (`publications` du
  `content_id`, sinon `publish_ref`).
- **`/watch/radar` — le pool.** Items `pool` des 7 derniers jours triés par score
  décroissant, avec `visual`. Action unique : **« Créer une idée »** (idée + source
  `url`, même geste que le clipper) — l'item mémorise `idea_id`, l'agent prend le
  relais par le flux standard.
- **`/settings/watch` — réglages.** CRUD des feeds, thèmes, style, « média exigé »,
  canal de validation, config de publication write-only. Une entrée de plus dans le
  tableau `SETTINGS` de la sidebar.

Event nouveau dans `src/lib/events.ts` : `watch.updated { itemId, status }`, émis à
chaque dépôt MCP, décision, expiration.

## 7. Hors périmètre

Pondération du score par le studio (le score appartient au worker), publication par
le studio lui-même, planification/cron, analytics de retour des posts publiés,
drag & drop, tout nommage de plateforme ou de fournisseur.

## 8. Tests

Postgres réel, patterns du repo (`signUpTestUser`, `callMcpTool`) :

- `tests/watch.test.ts` — lib : validation atomique (échec d'étape ⇒ item reste
  `proposed`), refus, expiration paresseuse, purge du pool, immuabilité des items
  décidés, `channel_key` manquant ⇒ erreur.
- `tests/mcp-watch.test.ts` — les 6 outils via le vrai handler HTTP, dont
  l'idempotence d'`upsert_watch_items` et le refus de toucher un item décidé.
- Redaction de `publish_config` sur les trois chemins HTTP.
- Isolation : « le workspace B ne voit rien du workspace A » sur les trois tables.
- `tests/schema.test.ts` : présence des trois tables.
