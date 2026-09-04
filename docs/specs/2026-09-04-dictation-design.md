# Vague « dictée partout » — spécification de conception

**Date** : 2026-09-04
**Statut** : implémenté (plan docs/plans/2026-09-04-dictation.md)
**Périmètre** : pouvoir dicter à la place de taper dans TOUTES les zones de saisie de
content-studio (champs, zones de texte, éditeurs tiptap), avec transcription 100 %
locale par mlx-whisper sur le Mac, en asynchrone : on dicte, on continue à travailler,
le texte arrive dans le champ quand il est prêt, et rien n'est jamais perdu.

Modèle de référence : la dictée du `/triage` de formation-vdl-review
(`~/Coding/formation-vdl-review/transcribe-daemon.mjs` + `transcribe-worker.py`) —
audio envoyé au serveur, daemon local notifié en temps réel, processus Python résident
qui garde le modèle chargé (≈ 2 s par dictée), déchargé après 15 min d'inactivité.

Principe fondateur inchangé : **l'outil n'exécute rien**. Il stocke l'audio, pose un
job `transcribe`, et un worker connecté en MCP transcrit puis rend le texte. C'est
déjà le circuit de la dictée des commentaires de relecture (vague cockpit agent) ; cette
vague le généralise à tout champ et livre enfin le worker qui le consomme.

---

## 0. Décisions de cadrage (validées)

- **Micro par champ**, intégré aux primitives `Input`/`Textarea` (opt-out par prop) et
  aux éditeurs tiptap — aucun câblage par call site, les champs futurs l'ont d'office.
- **Audio via le serveur + worker local** (pas de daemon HTTP local attaqué par le
  navigateur) : marche depuis un téléphone ou une instance distante, l'audio ne sort
  jamais chez un tiers.
- **Asynchrone** : le champ affiche « transcription… », l'utilisateur continue, le
  texte s'insère à l'arrivée par SSE.
- **Rien n'est perdu** : chaque dictée est une ligne persistée, visible dans un tiroir
  « Dictées » (Copier / Réessayer / Supprimer) si son champ n'est plus monté.

---

## 1. Modèle de données

### 1.1 Tables

```
dictations       id uuid pk, workspace_id (fk cascade, not null),
                 status text enum('pending','done','failed') default 'pending',
                 text text default '', error text,
                 field_key text not null default '',   -- identifiant du champ d'origine, opaque
                 consumed_at timestamp,                -- le champ a inséré le texte
                 created_by text, created_at, updated_at
index (workspace_id, status) ; index (workspace_id, field_key)

dictation_audio  dictation_id uuid pk (fk dictations cascade), mime text, bytes bytea,
                 size int, created_at
```

- `dictation_audio` suit le pattern de `comment_audio` : pas de `workspace_id`, cloisonné
  par la ligne parente ; **purgé dès que la transcription réussit**, conservé tant qu'un
  réessai est possible (`failed`).
- `field_key` est libre côté serveur (max 200 caractères). Convention côté client :
  `idea:<id>:notes`, `source:<id>:text`, `content:<id>:body`, `chat:<laneId>`, sinon
  `<pathname>#<name|id|placeholder>`.
- **Migration SQL** : oui, deux tables (`drizzle-kit generate` + `migrate`). Les enums
  étendus (`agent_jobs.target_type`, événements) restent côté Drizzle.

### 1.2 Bornes (partagées)

`MAX_AUDIO_BYTES = 16 Mo`, `AUDIO_MIMES` (webm/opus, mp4, ogg, wav, mpeg) et le lecteur
de corps borné `readBodyBounded` **sortent** de `src/lib/comments.ts` et de la route
audio des commentaires vers un module partagé `src/lib/audio.ts` ; `comments.ts` et sa
route l'importent (aucun changement de comportement). Durée max d'enregistrement :
`MAX_RECORD_MS = 3 min` (inchangé, `useRecorder`).

### 1.3 `agent_jobs.target_type` gagne `dictation`

Enum Drizzle : `('idea','content','comment','source','dictation')`. `assertTarget`
vérifie la dictée dans CE workspace ; `targetTitle` rend « Dictée <field_key> ».

---

## 2. Cycle de vie d'une dictée

```
POST /api/dictations (audio) ──▶ dictations(pending) + dictation_audio + job transcribe(dictation)
   worker : claim → GET /api/jobs/:id/audio → ffmpeg → mlx-whisper → complete_job({ text })
      ──▶ effet post-commit : text, status done, audio purgé, dictation.updated
   fail / cancel / silence ──▶ status failed + error (audio conservé), dictation.updated
   POST /api/dictations/:id/retry ──▶ failed → pending, retryJob (sinon createJob neuf)
   POST /api/dictations/:id/consume ──▶ consumed_at = now (le champ a inséré le texte)
   DELETE /api/dictations/:id ──▶ ligne + audio supprimés (annule un job queued)
```

- **Garde `completeJob`** (même pattern que transcribe/comment) : un job `transcribe`
  ciblant une dictée exige `result.text: string`, vérifié AVANT `finish` — sinon erreur,
  le job reste `running`.
- **Effets d'échec** (`applyFailureEffects`) : `failDictation(id, message)` sur
  `fail_job`, `cancel_job` et balayage « agent silencieux » — jamais de rétrogradation
  d'une dictée déjà `done`.
- **Unicité** : un job actif par dictée (règle `createJob` existante).
- **Bornes lib** : mime hors liste → erreur « type audio non supporté » ; taille
  > 16 Mo → « audio trop gros » ; audio vide → « audio vide » ; `field_key` > 200 →
  « field_key trop long ». Texte transcrit borné à 200 000 caractères (même borne que
  `MAX_SOURCE_TEXT_LENGTH`), jamais tronqué en silence.

---

## 3. Routes HTTP

| Route | Auth | Rôle |
|---|---|---|
| `POST /api/dictations?field_key=` | session | corps = audio brut (`content-type` = mime). 201 `{ id, status }`. 400/413/415 comme la route audio des commentaires. |
| `GET /api/dictations?status=&limit=` | session | tiroir : 50 dernières par défaut, plus récentes d'abord, sans l'audio. |
| `GET /api/dictations?field_key=&open=1` | session | au montage d'un champ : ses dictées `pending` + `done` non consommées. |
| `POST /api/dictations/[id]/retry` | session | 200 dictée, 409 si non `failed`, 404. |
| `POST /api/dictations/[id]/consume` | session | 200 dictée ; idempotent. |
| `DELETE /api/dictations/[id]` | session | 204 ; 404. |
| `GET /api/jobs/[id]/audio` | Bearer MCP | **étendue** : sert l'audio d'un job transcribe ciblant un commentaire (existant) OU une dictée. |
| `GET /api/events` | session **ou Bearer MCP** | **étendue** : `resolveMcpToken` si l'en-tête Authorization est présent — le worker s'abonne au flux du workspace du token. |

**Déviation assumée (plan)** : le paramètre de reprise s'appelle `open=1` (pending + done
non consommée), pas `pending=1`.

---

## 4. Worker — un seul process sur le Mac

`scripts/extract-worker.mjs` est renommé `scripts/worker.mjs` (README mis à jour) et
prend en charge deux kinds :

- `extract` : inchangé (Readability, yt-dlp + mlx-whisper CLI pour les vidéos).
- `transcribe`, cibles `comment` (legacy — enfin consommé sans session Claude) et
  `dictation` : `GET /api/jobs/:id/audio` → `ffmpeg -ac 1 -ar 16000` → processus Python
  résident → `complete_job({ text })` ; toute erreur → `fail_job(message)`.

**Processus Python résident** `scripts/transcribe-worker.py` (repris de VDL) : charge
`mlx-community/whisper-large-v3-turbo` au démarrage (`warm()`), lit un chemin `.wav`
par ligne sur stdin, rend une ligne JSON `{ text, sec } | { error }`. Langue `fr`
(`CS_WHISPER_LANG`), `initial_prompt` = vocabulaire IA/SEO/no-code de La Minute IA
(`CS_WHISPER_PROMPT`), `condition_on_previous_text=False`, filtre anti-hallucination
(segment > 20 mots avec < 25 % de mots distincts écarté). Déchargé après 15 min sans
travail, relancé à la dictée suivante. Python : `CS_PYTHON`, défaut
`~/.claude/tools/yt-transcript/venv/bin/python`.

**Notification temps réel** : le worker ouvre `GET /api/events` en Bearer et déclenche
un tour de boucle dès qu'un `job.updated` `queued` arrive ; le poll toutes les 15 s
reste le filet (coupure réseau, redémarrage du serveur). Latence attendue : < 1 s de
prise en charge + ≈ 2 s de transcription pour 30 s d'audio.

**Prérequis machine** : `ffmpeg` (déjà requis par yt-dlp), le venv `yt-transcript`
(mlx-whisper), Apple Silicon. Absents → `fail_job` explicite, jamais un crash de boucle.

---

## 5. UI

### 5.1 Hook `useDictation({ fieldKey, onText })` (`src/hooks/use-dictation.ts`)

- Enregistre via `useRecorder` (déplacé de `components/review/` vers `src/hooks/`,
  inchangé), poste l'audio, garde la liste des ids `pending` du champ.
- S'abonne à `dictation.updated` : sur `done` d'un id du champ (ou d'un `field_key`
  identique), charge le texte, appelle `onText(text)`, puis `consume`.
- Au montage : `GET /api/dictations?field_key=&pending=1` — reprend les `pending`
  (compteur) et insère les `done` non consommées (reload pendant la transcription).
- Expose `{ supported, recording, pending: number, start, stop, error }`.

### 5.2 `DictateButton` (`src/components/dictate-button.tsx`)

Bouton micro compact (icônes lucide, pas d'emoji) : `idle` (`Mic`), `recording`
(icône `Square`, pulsation, clic = terminer), `pending` (icône `Loader` + compteur).
Micro refusé/non supporté → bouton absent (pas de bouton mort). Titre d'accessibilité
« Dicter » / « Terminer la dictée » / « n transcription(s) en cours ».

### 5.3 Primitives `Input` et `Textarea`

- Micro intégré **par défaut** : conteneur `relative`, bouton absolu à droite, padding
  droit ajouté au champ. Prop `dictation?: false | { fieldKey?: string }` ; désactivé
  automatiquement pour `type` email/password/url/number/search et `readOnly`/`disabled`.
- **Insertion au curseur sans connaître l'état React** (`src/lib/insert-text.ts`) :
  `computeInsertion(value, selStart, selEnd, text, { singleLine })` est une fonction
  PURE (testée en node) qui rend `{ value, caret }` — espace ajouté avant le texte si le
  curseur suit un caractère non blanc, retours à la ligne remplacés par des espaces en
  `singleLine`. La glue DOM `insertAtCursor(el, text)` applique le résultat via le
  setter natif du prototype (`HTMLInputElement`/`HTMLTextAreaElement`) puis dispatch un
  événement `input` bubbles — React déclenche `onChange` comme pour une frappe.
- Clé de champ par défaut : `${pathname}#${name ?? id ?? placeholder ?? "field"}` ;
  explicite là où ça compte : notes d'idée (`idea:new:notes` puis `idea:<id>:notes`),
  texte source (`source:new:text`), chat (`chat:<laneId>`).

### 5.4 Éditeurs tiptap (`editor.tsx`, `review-pane.tsx`)

`DictateButton` posé dans le coin supérieur droit de l'éditeur ; insertion par
`editor.chain().focus().insertContent(text).run()` au curseur ; `fieldKey =
content:<id>:body` (éditeur) et `content:<id>:review` (relecture).

**Déviation assumée (plan)** : pas de micro sur l'éditeur de relecture (lecture seule) —
les commentaires se dictent via la `Textarea` du popover (§5.5).

### 5.5 Call sites existants

- Chat (`chat-drawer.tsx`) : le `<textarea>` brut passe sur la primitive `Textarea`
  (ref, `onKeyDown`, `onClick` transmis tels quels).
- Commentaires (`comment-popover.tsx`) : le bouton « Dicter » maison disparaît, la
  `Textarea` du popover porte le micro standard ; un commentaire dicté est enregistré
  comme commentaire **texte**. Le flux « commentaire vocal » legacy (route audio,
  `kind: "voice"`, job transcribe/comment) reste en place et servi par le worker ;
  décommission dans une vague ultérieure.
- Login/register : pas de micro (types email/password, et `dictation={false}` sur le nom).

### 5.6 Tiroir « Dictées » (`src/components/dictations-tray.tsx`)

Entrée dans la barre latérale (section principale, sous les vues), badge = nombre de
`pending`. Panneau : liste des 50 dernières dictées, plus récentes d'abord — statut
(pastille `StatusBadge` : `pending`/`done`/`failed`, teintes existantes), extrait du
texte (120 caractères), « insérée » si `consumed_at`, actions **Copier** (presse-papiers),
**Réessayer** (failed), **Supprimer**. Live via `dictation.updated`.

**Déviation assumée (plan)** : le tiroir est une page `/dictations` + entrée de barre
latérale avec badge, pas un panneau tiroir superposé.

---

## 6. Événements

`WorkspaceEvent` gagne `{ type: "dictation.updated"; dictationId: string; fieldKey:
string; status: string }`, émis par la lib à chaque transition (création, done, failed,
retry, consume, delete → status `"deleted"`). `job.updated` gagne `"dictation"` dans
l'union `targetType`.

---

## 7. Tests (vitest, TDD)

- `lib/audio` : bornes partagées ; `comments` non régressé (suite existante).
- `dictations` : création (mime/taille/vide/field_key), `applyDictation` (text, done,
  audio purgé, événement), `failDictation` (jamais sur done), retry (failed → pending,
  job requeued ; 409 sinon), consume idempotent, delete (job queued annulé),
  cloisonnement workspace.
- `jobs` : cible `dictation` (assertTarget, targetTitle), garde `completeJob`, effets
  d'échec sur fail/cancel.
- Routes : POST (201/400/413/415/401), GET liste + `field_key&pending`, retry, consume,
  DELETE ; `/api/jobs/[id]/audio` pour une dictée ; `/api/events` en Bearer (200 avec
  token, 401 sans/invalide, un token ne reçoit que les événements de son workspace).
- `computeInsertion` : tests unitaires purs (espace de séparation, remplacement d'une
  sélection, `singleLine`, curseur en début/fin). La glue DOM `insertAtCursor` n'est pas
  testée automatiquement (pas d'environnement DOM dans la suite) — contrôle visuel.
- Worker/Python : pas de test automatisé (binaires locaux) ; smoke manuel documenté.

---

## 8. Hors périmètre (explicitement)

- Streaming partiel pendant la dictée.
- Détection automatique de la langue (français forcé, surchargeable par env).
- Suppression du flux « commentaire vocal » legacy (tables `comment_audio`, `kind:
  "voice"`) — conservé, décommission plus tard.
- Dictée globale par raccourci clavier ; bouton flottant.
- Correction/ponctuation par LLM après transcription.
