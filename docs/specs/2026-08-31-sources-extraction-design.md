# Vague « sources & extraction » — spécification de conception

**Date** : 2026-08-31
**Statut** : implémenté (plan docs/plans/2026-08-31-sources-extraction.md)
**Périmètre** : rendre les sources d'une idée réellement exploitables, façon NotebookLM —
déposer des articles (URL), des vidéos YouTube (transcript audio via mlx-whisper) et des
textes collés longs, faire extraire le contenu par un worker externe, et le montrer dans
l'UI. Les contenus dérivés (article FR, posts X, script vidéo) empruntent ensuite le flux
`write` existant, inchangé.

Principe fondateur inchangé : **l'outil n'exécute rien** — pas de fetch serveur, pas de
transcription serveur. Il consigne la source (`pending`), pose un job `extract`, et un
worker connecté en MCP fait le travail puis rend compte (`attach_extraction`).

Cas d'usage de référence : sauvegarder https://www.dwarkesh.com/p/openai-huggingface sur
une idée, y ajouter des vidéos YouTube et des notes collées, puis demander à l'agent
d'écrire un article FR, des posts X FR/EN, un script YouTube depuis ce corpus.

---

## 0. Décisions de cadrage (validées)

- **Idée = dossier source.** Une source reste TOUJOURS rattachée à une idée
  (`sources.idea_id NOT NULL`, inchangé). Pas de bibliothèque workspace détachée.
- **Toute extraction passe par un job worker** — y compris les articles (pas de fetch
  serveur : cohérence, pas de SSRF, l'app peut tourner en Docker sans réseau sortant ni
  GPU).
- **Worker : « les deux »** — un script déterministe dédié (`scripts/worker.mjs`,
  zéro token LLM) ET le kind documenté dans le README worker pour qu'un Claude branché en
  MCP puisse le faire en dépannage.

---

## 1. Modèle de données — zéro migration SQL

Les colonnes nécessaires existent déjà (`sources.extracted_text`, `extracted_meta`,
`status`). Les deux enums modifiés sont des colonnes `text` avec enum côté Drizzle
uniquement — aucune migration.

### 1.1 Kinds de source acceptés

| kind | ref | contenu | statut à la création |
|---|---|---|---|
| `url` | l'URL http/https | à extraire (Readability) | `pending` + job `extract` |
| `video` | l'URL YouTube | à extraire (yt-dlp + mlx-whisper) | `pending` + job `extract` |
| `text` | étiquette : ~120 premiers caractères du texte | le texte lui-même, fourni au dépôt | `extracted` d'emblée, pas de job |
| `pdf`, `audio` | — | upload binaire : toujours refusé (v1.1, attend la table assets) | — |

- **Détection YouTube dans `addSource`** (lib — couvre UI, MCP `add_source` et
  `/api/clip` d'un coup) : une `ref` de kind `url` dont l'hôte est
  `youtube.com`/`www.youtube.com`/`m.youtube.com` (chemins `/watch` avec `v=`,
  `/shorts/<id>`, `/live/<id>`) ou `youtu.be/<id>` est **reclassée `video`**. L'appelant
  peut aussi passer `kind: "video"` explicitement ; dans ce cas la ref DOIT être une URL
  YouTube reconnue, sinon erreur (« video = URL YouTube en v1.1 »). La fonction de
  détection est exportée (`youtubeVideoId(ref): string | null`) et testée seule.
- **Kind `text` : le contenu change de place.** Aujourd'hui l'UI met le texte collé dans
  `ref` (borné à 2000). Désormais `addSource` kind `text` prend le contenu dans un champ
  dédié (`input.text`), l'écrit dans `extracted_text`, pose `status: "extracted"`
  directement, et fabrique `ref` = première ligne non vide tronquée à 120 caractères.
  Nouvelle borne : `MAX_SOURCE_TEXT_LENGTH = 200_000` caractères. L'appel `kind: "text"`
  sans `input.text` est une erreur.
- `extracted_text` gagne une borne à l'écriture (`attachExtraction`) :
  `MAX_SOURCE_EXTRACTED_LENGTH = 1_500_000` caractères (≈ 25 h de transcript) — au-delà,
  erreur claire, jamais de troncature silencieuse (même règle que les bornes existantes).

### 1.2 `agent_jobs.target_type` gagne `source`

Enum Drizzle : `('idea','content','comment','source')`. `assertTarget` vérifie la source
dans CE workspace ; `targetTitle` (listJobs) rend `title` de la source, sinon `ref`.

---

## 2. Cycle de vie de l'extraction

### 2.1 Création

`addSource` (kinds `url`/`video`) crée, après l'insert, un job :

```
kind: "extract", targetType: "source", targetId: <source.id>,
payload: { source_kind, ref }, requestedBy: <userId | "mcp">
```

Unicité par la règle `createJob` existante (coalesce: false) : une source n'a jamais deux
jobs extract actifs. La création du job est **post-insert et non bloquante** dans le même
style que les effets post-commit de jobs.ts : si elle échoue, la source existe en
`pending` et le bouton Réessayer (§2.3) permet de reposer un job.

### 2.2 Côté worker (contrat MCP, inchangé dans ses outils)

`claim_job` → travail (heartbeat toutes les 60 s pour une vidéo longue) →
`attach_extraction(source_id, extracted_text, extracted_meta)` → `complete_job(job_id)`.

- **Garde dans `completeJob`** (même pattern que `transcribe`) : un job `extract` ne peut
  passer `done` que si la source cible est en statut `extracted`. Sinon erreur — le job
  reste `running`, le worker peut corriger (appeler `attach_extraction` puis retenter).
- `extracted_meta` attendue (informative, non contractuelle) :
  `{ title?, byline?, site?, lang?, duration_s?, model?, tool? }`.
- `attachExtraction` pose aussi `title` de la source si elle n'en avait pas et que
  `extracted_meta.title` est fourni (une URL déposée sans titre en gagne un).

### 2.3 Échecs et réessai

- `fail_job` / `cancel_job` / balayage « agent silencieux » sur un job `extract` →
  **effet post-commit** `markSourceFailed(source_id, message)` (ajouté à
  `applyFailureEffects`) : la source passe `failed`, la raison est visible dans l'UI.
  **Évolution (polish post-merge)** : `markSourceFailed` ne rétrograde jamais une source
  déjà `extracted` — le cas réel est un `attach_extraction` réussi suivi d'un
  `complete_job` raté ; le texte attaché prime sur l'échec administratif du job.
- Bouton **Réessayer** sur une source `failed` : `POST /api/sources/[id]/retry` →
  repasse la source en `pending` (reset `extracted_meta.error`) puis `retryJob` sur le
  dernier job extract failed de cette source s'il existe, sinon `createJob` neuf. Réponse
  = la source à jour.
- **Déviation assumée (revue finale, TOCTOU)** : `retrySourceExtraction` conditionne
  l'update à `WHERE status = 'failed'` et lève une erreur si la ligne n'a pas bougé, pour
  fermer la fenêtre où la source changerait de statut entre le check et l'update.

### 2.4 Événements

`bus.publish` (events.ts) : nouvel événement `source.updated { sourceId, ideaId, status }`
émis par `attachExtraction` et `markSourceFailed` (et par le retry). La fiche idée
s'abonne (use-workspace-events, comme `job.updated`) et rafraîchit sa liste de sources.

---

## 3. Worker script — `scripts/worker.mjs`

Node ESM, tourne sur le Mac (là où vivent yt-dlp et mlx-whisper). Ne touche jamais la
base : il parle exclusivement MCP, comme n'importe quel worker.

- **Config env** : `CS_MCP_URL` (ex. `http://localhost:3003/api/mcp`), `CS_MCP_TOKEN`
  (token workspace). `--once` : un seul passage puis exit (cron/launchd) ; défaut :
  boucle, poll toutes les 15 s. `worker_label` = `worker@<hostname>` (Task 4 : script renommé
  `scripts/worker.mjs`, un seul process traite aussi les jobs `transcribe`).
- **Client MCP** : `@modelcontextprotocol/sdk` (déjà présent en peer de mcp-handler),
  transport streamable HTTP + Bearer.
- **Boucle** : `list_jobs({status:"queued", kind:"extract"})` → pour chaque job :
  `claim_job` (une défaite de claim = un autre worker a gagné, on passe) → extraction →
  `attach_extraction` → `complete_job` ; toute erreur → `fail_job(message lisible)`.
  Heartbeat sur un timer pendant l'extraction.
- **kind `url`** : `fetch` avec UA navigateur + timeout 30 s ; content-type HTML →
  `linkedom` (parse) + `@mozilla/readability` → `textContent` + `{title, byline,
  siteName, lang}`. Content-type non HTML (PDF compris) → `fail_job("contenu non HTML
  (<type>) — dépose le texte à la main")` en v1.1.
- **Déviation assumée (revue finale, durcissement sécurité)** : `extractUrl` ajoute
  `assertPublicHttpUrl` (refuse localhost/`.local`/IP privées/link-local) et suit les
  redirections À LA MAIN (max 5 hops, chaque hop re-validé) — non prévu tel quel dans le
  design initial, ajouté pour fermer un SSRF côté worker.
- **kind `video`** : `yt-dlp -x --audio-format m4a -o <tmp>` (répertoire temporaire
  dédié, nettoyé en `finally`) → `mlx_whisper --model mlx-community/whisper-large-v3-turbo`
  → texte brut ; meta `{title (yt-dlp), duration_s, model: "whisper-large-v3-turbo",
  tool: <identifiant littéral conservé tel quel dans le code, non renommé par Task 4>}`.
  Binaire manquant (yt-dlp ou mlx_whisper introuvable) →
  `fail_job` explicite, jamais un crash de la boucle.
- **Déviation assumée (revue finale, durcissement sécurité)** : l'appel `yt-dlp` insère
  une sentinelle `--` avant la ref pour qu'une URL commençant par `-` ne soit jamais
  interprétée comme une option de la commande.
- **Deps npm ajoutées** (dépendances de dev du repo, vérifiées légitimes) :
  `@mozilla/readability` (Mozilla), `linkedom` (WebReflection). Rien d'autre.

**README** : la table des kinds worker gagne la ligne `extract` (« cible source, créé au
dépôt d'une url/vidéo ; le worker appelle attach_extraction puis complete_job ; script
fourni : `node scripts/worker.mjs` ») — suffisant pour qu'un Claude worker le
fasse à la main en dépannage.

---

## 4. UI — fiche idée (`idea-detail.tsx`)

- **Dépôt** : le champ URL détecte YouTube en tapant (badge « vidéo YouTube » via
  `youtubeVideoId`) ; le textarea texte accepte les longs collages (borne 200 000,
  compteur au-delà de 1000 caractères) et part en `input.text` (plus jamais dans `ref`).
- **Ligne source** : pastille de statut — `pending` : « extraction en attente » (et
  « aucun worker branché » si le job attend, comme les jobs existants) ; `extracted` :
  cliquable ; `failed` : raison (depuis `extracted_meta.error`) + bouton Réessayer.
- **Panneau texte extrait** : clic sur une source `extracted` → panneau/accordéon dans la
  fiche : titre, méta (site/durée/langue), nombre de mots, texte scrollable. Lecture
  seule.
- **Déviation constatée (revue finale)** : le panneau affiche le nombre de mots et le
  texte scrollable ; le titre reste dans l'en-tête de la ligne (pas dupliqué dans le
  panneau) et les méta site/durée/langue de `extracted_meta` n'y sont pas encore
  affichées — accepté pour la clôture v1.1, à reprendre si l'usage le demande.
- **Déviation assumée (revue finale)** : l'indice worker s'affiche dès qu'une source est
  `pending`, sans distinguer job en attente / extraction en cours — copie neutre
  (« en attente ou en cours ») couvrant les deux états, plutôt qu'un câblage useJobs par
  source.
- **Live** : abonnement `source.updated` → refetch de la liste.

---

## 5. MCP

- `add_source` : description mise à jour (video = URL YouTube, text = contenu dans le
  nouveau champ `text`), même chemin lib → job automatique. Schéma : `text` optionnel,
  requis si kind `text`.
- `list_sources` : filtre `idea_id` optionnel (la lib le supporte déjà).
  **Évolution (polish post-merge)** : la liste est ALLÉGÉE — `extracted_text` remplacé
  par `extractedTextLength` (un corpus pèse jusqu'à 1,5 Mo par source) ; le texte complet
  se lit via `get_source`. Même contrat côté HTTP (`GET /api/ideas/[id]/sources`), avec
  une nouvelle route `GET /api/sources/[id]` que le panneau de la fiche idée charge au
  clic.
- `get_source` : inchangé — rend `extracted_text`, c'est ce que lit l'agent rédacteur
  avant un `write`.
- `attach_extraction` : inchangé (borne 1,5 M appliquée par la lib).

---

## 6. Tests (vitest, TDD)

- `sources` : détection YouTube (watch/shorts/youtu.be/hôtes mobiles, négatifs :
  vimeo, `javascript:`) ; kind `text` → `extracted` direct + ref étiquette + borne ;
  kind `video` non YouTube refusé ; job extract créé pour url/video, pas pour text ;
  borne `attachExtraction`.
- `jobs` : targetType `source` (assertTarget, targetTitle) ; garde `completeJob` extract
  (source non extraite → erreur, job reste running) ; `applyFailureEffects` →
  `markSourceFailed` sur fail/cancel/silence.
- Route retry : failed → pending + job requeued ; refus si la source n'est pas failed.
- Le worker script n'est pas testé en réseau (dépend de yt-dlp/mlx-whisper locaux) ; sa
  logique partageable (détection YouTube) vit dans la lib, testée.

---

## 7. Hors périmètre (explicitement)

- Upload binaire pdf/audio (attend la table assets / storage).
- Extraction PDF par URL (le worker répond « non HTML » en v1.1).
- Timestamps/SRT dans les transcripts (texte brut seul ; yt-transcript reste l'outil
  hors studio pour ça).
- Bibliothèque de sources inter-idées, dédoublonnage d'URL entre idées.
- RAG/embedding sur les sources : l'agent lit le texte entier via `get_source`.
