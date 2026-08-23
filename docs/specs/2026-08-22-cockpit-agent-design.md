# Vague « cockpit agent » — spécification de conception

**Date** : 2026-08-22
**Statut** : implémenté (plan docs/plans/2026-08-22-cockpit-agent.md)
**Périmètre** : trois briques génériques de content-studio — **jobs**, **publications**,
**relecture & dictée** — qui font de l'outil le poste de pilotage d'un worker externe.
Premier consommateur : le pipeline « Actus IA » de La Minute IA (spec séparée, dans le
dossier projet La Minute IA : `docs/superpowers/specs/2026-08-22-actus-ia-pipeline-design.md`).
Rien ici ne nomme ce consommateur : tout workspace, tout worker.

Principe fondateur inchangé : **l'outil n'appelle jamais de modèle et ne publie jamais
lui-même**. Il consigne des demandes (jobs), des liens vers l'extérieur (publications) et
des remarques (commentaires) ; un worker, connecté par MCP avec un token de workspace,
fait le travail et rend compte.

---

## 0. Vocabulaire

- **Job** : une demande de travail posée par un humain (bouton) ou par une règle de
  l'outil (hook), consommée par un worker externe. Kind libre (texte) ; cinq kinds
  « intégrés » ont des effets connus de l'UI : `write`, `publish`, `sync`, `revise`,
  `transcribe`.
- **Worker** : n'importe quel process qui sonde `list_jobs`, `claim_job`, fait, puis
  `complete_job` / `fail_job`. L'outil ne le connaît pas, ne le lance pas, ne l'attend
  pas : un workspace sans worker voit ses jobs rester `queued`, et l'UI le dit.
- **Publication** : le lien entre un contenu du studio et un objet publié ailleurs
  (`target` + `external_id` + `url`). Sert à afficher « publié ici », à détecter
  « modifié depuis », et à demander une re-synchronisation.
- **Commentaire** : une remarque ancrée sur un passage d'un contenu (ou générale), écrite
  ou dictée, que l'humain pose en relisant et qu'un agent applique.

---

## 1. Jobs

### 1.1 Table `agent_jobs`

```
agent_jobs  id uuid pk, workspace_id (fk, not null), kind text,
            target_type text enum('idea','content','comment'), target_id uuid,
            payload jsonb default {}, status text enum('queued','running','done','failed','cancelled'),
            result jsonb default {}, error text, attempts int default 0,
            requested_by text (user id ou 'system:<règle>'), claimed_by text (label du worker),
            last_heartbeat_at timestamp, created_at, started_at, finished_at
index (workspace_id, status) ; index (workspace_id, target_type, target_id)
```

`target_id` n'a pas de FK (trois tables cibles possibles) ; le cloisonnement passe par
`workspace_id`, vérifié à chaque lecture/écriture, et la lib vérifie à la création que la
cible existe **dans ce workspace** (sinon 404).

### 1.2 Règles d'unicité (lib, pas UI)

`createJob(ws, {kind, targetType, targetId, payload, requestedBy, coalesce})` :

- `coalesce: false` (défaut) — s'il existe déjà un job **actif** (`queued` ou `running`)
  pour `(kind, target)`, on le rend tel quel, rien n'est créé. Un double clic sur
  « Rédiger » ne produit jamais deux brouillons.
- `coalesce: true` — s'il existe un job `queued` pour `(kind, target)`, on le rend ; s'il
  n'existe qu'un `running`, on **crée** un nouveau `queued` (il rattrapera l'état final
  quand le worker relira la cible). C'est le mode du hook de re-synchronisation (§2.3) :
  une rafale d'autosauvegardes donne au plus un job en attente.

### 1.3 Cycle de vie

```
queued ──claim──▶ running ──complete──▶ done
   │                 │ ─────fail──────▶ failed ──retry──▶ queued (attempts+1)
   └──cancel──▶ cancelled              ──(silence > 10 min)──▶ failed("agent silencieux")
```

- `claim_job(job_id, worker_label)` : `UPDATE … SET status='running', claimed_by, started_at,
  last_heartbeat_at=now() WHERE id=? AND workspace_id=? AND status='queued' RETURNING` —
  atomique ; zéro ligne = 409 `already_claimed`.
- `heartbeat_job(job_id)` : le worker l'appelle pendant un travail long (toutes les
  60 s). Un job `running` sans battement depuis **10 min** est basculé en `failed` avec
  l'erreur « agent silencieux » — balayage paresseux au moment de `list_jobs`/`GET /api/jobs`
  (pas de cron dans l'outil), et c'est ce qui libère l'unicité si un worker meurt.
- `complete_job(job_id, result?)` / `fail_job(job_id, error)` : seulement depuis `running`
  (sinon 409). `error` tronqué à 2 000 caractères, lisible tel quel dans l'UI.
- `retry` (UI) : `failed` → `queued`, `attempts+1`, `error` conservé dans l'historique
  (`payload.previous_errors[]`). `cancel` (UI) : `queued` → `cancelled` uniquement.

### 1.4 Effets des kinds intégrés (documentés, pas d'autre magie)

À la **création** (route session, donc UI) :
- `write` sur une idée → l'idée passe `in_progress` ; `payload.channel_key` requis.
- `publish` sur un contenu → le contenu passe `approved` (corps non vide requis, 400 sinon).
- `revise` sur un contenu → rien (le worker posera une révision).
- `sync` → créé par le hook §2.3, jamais par un bouton (le bouton « Re-synchroniser »
  de la carte publication passe quand même par `POST /api/jobs` avec `kind: "sync"`).
- `transcribe` sur un commentaire → créé par la route audio (§3.4), jamais par un bouton.

À la **complétion** :
- `transcribe` (cible `comment`) avec `result.text` → le commentaire reçoit `body=text`,
  `transcription='done'` ; `fail_job` → `transcription='failed'`. C'est la seule
  complétion qui écrit ailleurs que dans `agent_jobs` : pour les autres kinds, le worker
  pose lui-même les statuts (`set_content_status`, `update_idea`, `link_publication`,
  `mark_synced`) — le job ne fait que porter le résultat (`content_id`, `url`…).

### 1.5 API session (UI)

- `POST /api/jobs` `{kind, target_type, target_id, payload?, coalesce?}` → 201 + job (ou
  200 + job existant si dédoublonné). Applique les effets de création §1.4.
- `GET /api/jobs?target_type=&target_id=` → jobs de la cible, du plus récent au plus ancien
  (balayage des silencieux avant réponse).
- `POST /api/jobs/:id/retry`, `POST /api/jobs/:id/cancel`.
- Toutes : `requireWorkspace` (session), 401 `TenantError`, 404 hors workspace.

### 1.6 MCP (worker)

`list_jobs(status?, kind?)` · `claim_job(job_id, worker_label)` · `heartbeat_job(job_id)`
· `complete_job(job_id, result?)` · `fail_job(job_id, error)` — plus deux outils de
statut qui manquaient aux workers : `set_content_status(content_id, status)` (même enum
que l'UI) et `update_idea(idea_id, status?, notes?, tags?)`. Tous bornés au workspace du
token ; `list_jobs` rend aussi `payload` et un résumé de la cible (titre) pour que le
worker n'ait pas à refaire un `get_*` juste pour logger.

### 1.7 SSE

Nouvel événement du bus : `{ type: "job.updated", jobId, kind, targetType, targetId, status }`
émis à chaque transition (création incluse). L'UI ne sonde pas.

### 1.8 UI

- **Page idée** : bouton « Rédiger » + sélecteur de canal (défaut : dernier canal choisi
  dans ce workspace, mémorisé `localStorage` ; sinon le premier). États du dernier job
  `write` : « Rédaction demandée » (queued ; après 2 min : « en attente d'un agent ») →
  « En cours… » (running, avec durée) → « Brouillon prêt → ouvrir » (done, lien
  `result.content_id`) → « Échec : <erreur> [Réessayer] ». Bouton désactivé tant qu'un
  job actif existe.
- **Page contenu** : bouton « Publier » (corps non vide) avec les mêmes états, lien
  `result.url` en `done` ; bouton « Appliquer les commentaires » (actif si commentaires
  `open`, §3) ; carte publication (§2.4).
- **Inbox** : pastille d'état du dernier job par carte (icône + tooltip), rien de plus.
- Composant unique `JobStatus` (kind, target) qui lit `GET /api/jobs` puis écoute le SSE.

### 1.9 Tests

Lib : création + unicité (`coalesce` false/true), claim concurrent (deux `claim_job`
simultanés sur le même job → un seul 200), transitions interdites (complete sur queued →
409), heartbeat/silence (job running, horloge avancée de 11 min, `list_jobs` le rend
`failed`), retry/cancel. Routes : 401 sans session, 404 cible d'un autre workspace, effets
de création (`write` → idée `in_progress`, `publish` sans corps → 400). MCP : le token du
workspace A ne liste, ne claim, ne complète jamais un job de B ; `set_content_status` et
`update_idea` cloisonnés. Bus : `job.updated` émis à chaque transition.

---

## 2. Publications

### 2.1 Table `publications`

```
publications  id uuid pk, workspace_id (fk), content_id (fk contents, cascade),
              target text, external_id text, url text, meta jsonb default {},
              published_body_hash text (sha256 du corps markdown tel que publié),
              published_at timestamp, synced_at timestamp, last_error text,
              created_at, updated_at
unique (content_id, target) ; index (workspace_id, target)
```

### 2.2 MCP

- `list_publications(target?, content_id?)` → liste (avec `content_id`, `external_id`,
  `url`, `published_body_hash`, `synced_at`). Sert au worker pour l'import (« ce feed
  est-il déjà lié ? ») et au `sync` (« quel external_id ? »).
- `link_publication(content_id, target, external_id, url, meta?, body_hash)` → upsert sur
  `(content_id, target)` ; pose `published_at` si absent, `synced_at=now()`, efface
  `last_error`.
- `mark_synced(publication_id, body_hash)` → `synced_at=now()`, `published_body_hash`,
  `last_error=null`. `fail_job` d'un `sync` pose aussi `last_error` sur la publication
  (le worker passe `publication_id` dans `payload`).

### 2.3 Hook « publié puis modifié »

Dans `applyContentUpdate`, **après** qu'une révision est devenue `current` (jamais pour
une `proposed`) : si le contenu a au moins une publication **et** que
`sha256(body) ≠ published_body_hash` de l'une d'elles → `createJob(ws, {kind:'sync',
targetType:'content', targetId, payload:{publication_id, target}, requestedBy:'system:publication-sync',
coalesce:true})`, un job par publication désynchronisée. Idempotent : une révision qui
ramène exactement le corps publié ne crée rien. Le worker est libre d'attendre un délai de
calme avant d'exécuter (le studio n'impose rien).

### 2.4 UI — carte « Publication » (page contenu)

Une ligne par publication : cible, lien « voir », puis l'un de : « synchronisé il y a N »
(`hash` identique) · « modifications en attente de sync » (+ état du job `sync` actif) ·
« échec : <last_error> [Re-synchroniser] » (crée un job `sync`, `coalesce:true`). La
carte est absente tant qu'aucune publication n'existe.

### 2.5 Tests

Upsert `link_publication` (même `(content, target)` → une ligne), cloisonnement, hook :
révision current sur contenu publié → un job `sync` coalescé (deux révisions rapides → un
seul `queued`) ; révision identique au hash → aucun job ; révision `proposed` → aucun job ;
`mark_synced` efface `last_error`.

---

## 3. Relecture & dictée

### 3.1 Tables

```
content_comments  id uuid pk, workspace_id (fk), content_id (fk contents, cascade),
                  quote text default '', prefix text default '', suffix text default '',
                  section text default '', body text default '',
                  kind text enum('text','voice'), status text enum('open','applied','resolved'),
                  transcription text enum('none','pending','done','failed') default 'none',
                  created_by text, created_at, updated_at
index (content_id) ; index (workspace_id)

comment_audio     comment_id uuid pk (fk content_comments, cascade), mime text,
                  bytes bytea, size int, created_at
```

Ancrage = le schéma VDL éprouvé : `quote` (le texte surligné, ≤ 2 000 car.) + `prefix` /
`suffix` (40 caractères de contexte de part et d'autre, pris dans le **texte rendu**). Un
commentaire « général » a `quote=''`. Audio en base (bytea, **≤ 16 Mo**, 413 au-delà),
**supprimé dès que la transcription aboutit** ; pas de stockage objet requis.

### 3.2 Algorithme d'ancrage (port de `trouverPassage`)

Sur le texte brut du rendu (`textContent` de la vue lecture) : 1) `indexOf(prefix+quote+suffix)` ;
2) sinon recherche sur blancs normalisés ; 3) sinon `indexOf(quote)` seule ; 4) sinon
« passage introuvable » (le commentaire reste listé et éditable, juste plus surligné).
Même fonction côté serveur (`lib/anchoring.ts`) pour que l'agent puisse situer un
commentaire dans le markdown, testée seule.

### 3.3 UI — onglet « Relire » (page contenu)

Deux onglets au-dessus du corps : **Éditer** (tiptap, existant) / **Relire**. En Relire :
rendu markdown en lecture seule ; sélection à la souris → le passage passe **jaune** et un
popover s'ouvre (textarea, bouton 🎙️, Enregistrer `Cmd+Entrée`, Échap annule) →
**vert** une fois enregistré ; clic sur un vert = rouvrir (modifier, marquer résolu,
supprimer). Colonne latérale : liste des commentaires (ancrés et généraux, avec leur
statut, « ⚠️ passage introuvable » le cas échéant), bouton « + Commentaire général ».
Les commentaires `applied`/`resolved` restent visibles, grisés, repliés par défaut.
Tout est temps réel via SSE (`comment.updated`).

### 3.4 Dictée

Bouton 🎙️ du popover : `MediaRecorder` (mime supporté détecté : `audio/webm;codecs=opus`
sinon `audio/mp4`), arrêt au second clic ou après 3 min. Envoi :
`POST /api/contents/:id/comments/audio?quote=…&prefix=…&suffix=…&section=…` (corps =
audio brut, `content-type` = mime) → crée le commentaire `kind:'voice'`,
`transcription:'pending'`, `body:''` **et** un job `transcribe` (cible `comment`) → 201
`{comment, job}`. Le popover affiche « Transcription en cours… » puis le texte, éditable
(on peut corriger la reconnaissance). Si le navigateur n'a pas `MediaRecorder`, le bouton
n'existe pas ; si le job échoue, le commentaire montre « transcription échouée
[Réessayer] » (retry du job) et reste éditable à la main.

### 3.5 Routes

Session : `GET/POST /api/contents/:id/comments`, `PATCH/DELETE /api/contents/:id/comments/:cid`
(body, status), `POST /api/contents/:id/comments/audio`.
**Token (worker, Bearer `cs_…`, même résolution que `/api/clip`)** :
`GET /api/jobs/:id/audio` → l'audio du commentaire cible (404 si le job n'est pas un
`transcribe` du workspace du token ou si l'audio est déjà purgé). C'est la seule route
REST binaire ouverte au token ; tout le reste du worker passe par MCP.
MCP : `list_comments(content_id, status?)` (rend aussi `anchor_found` et la position
calculée dans le markdown courant), `resolve_comment(comment_id, status)`
(`applied`|`resolved`|`open`).

### 3.6 SSE

`{ type: "comment.updated", contentId, commentId, status, transcription }`.

### 3.7 Tests

Ancrage (les 4 niveaux + introuvable, sur fixtures avec blancs/entités) ; CRUD
commentaires cloisonnés ; route audio : refus > 16 Mo, mime inconnu → 415, création
commentaire+job atomique ; `complete_job` d'un `transcribe` remplit le commentaire et
purge l'audio ; `fail_job` → `transcription:'failed'`, audio conservé pour retry ;
`GET /api/jobs/:id/audio` : 401 sans token, 404 token d'un autre workspace ; MCP
`list_comments` rend `anchor_found`.

---

## 4. Sécurité

- Aucune exécution côté serveur déclenchée par un job (contrairement aux lanes) : un job
  est une ligne en base. Un token compromis peut créer/consommer des jobs de SON workspace,
  lire ses commentaires et ses audios non encore transcrits — rien d'autre, rien hors
  workspace.
- Bornes : `error` 2 000 car., `payload`/`result` 64 Ko (400 au-delà), audio 16 Mo,
  `quote` 2 000, `body` 10 000.
- Les routes session restent sous `requireWorkspace` ; la seule route token ajoutée est
  `GET /api/jobs/:id/audio`, lecture seule, scellée au workspace du token.
- Pas de nouvelle exposition réseau : même port, même binding.

## 5. Migrations

Trois migrations drizzle (`agent_jobs` ; `publications` ; `content_comments` +
`comment_audio`), additives, sans modification des tables existantes. Les enums restent
des `text` avec `enum` côté drizzle, comme le reste du schéma.

## 6. Hors périmètre

Exécution de workers par l'outil (les lanes restent le seul cas, et restent telles
quelles), sync descendante depuis les cibles externes, notifications (mail/Discord) sur
transitions de jobs, stockage objet pour l'audio, transcription côté serveur (jamais : c'est
le worker), historique des diffs par commentaire appliqué (la révision suffit), SaaS /
multi-worker par workspace avec affectation (un worker prend ce qu'il veut ; si deux
workers se partagent un workspace, `claim_job` arbitre).

## 7. Ordre de livraison (chaque étape livre seule)

1. Jobs (lib → MCP → routes → UI idée/contenu → SSE) — déjà utile avec n'importe quel worker.
2. Publications (table, MCP, hook, carte).
3. Relecture (commentaires texte, onglet, ancrage, MCP).
4. Dictée (audio, job `transcribe`, route token).

Le plan d'implémentation découpera en tâches testables dans cet ordre.
