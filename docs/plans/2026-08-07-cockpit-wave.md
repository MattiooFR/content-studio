# Vague cockpit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refonte cockpit de l'UI + sources drop-anything (avec extension Chrome), funnel par canal, jauges d'abonnements multi-comptes, lanes de chat sur le CLI local.

**Architecture:** Spec de référence : `docs/specs/2026-08-07-cockpit-wave-design.md`. Un design system défini UNE fois (Task W1), toutes les surfaces construisent dessus. L'outil n'appelle jamais de modèle : extraction et rédaction viennent de l'agent (MCP) ; les lanes lancent le CLI LOCAL de l'utilisateur (self-host).

**Tech Stack:** existant (Next 16, Tailwind v4, Drizzle, better-auth, mcp-handler, TipTap, vitest) + rien de nouveau côté deps sauf nécessité prouvée.

## Global Constraints

- Port dev 3003 ; PG 127.0.0.1:55434 ; `npx vitest run` (jamais watch) ; suite ACTUELLE : 27 tests — chaque task annonce son compte attendu.
- `workspace_id NOT NULL` + cloisonnement testé sur toute nouvelle table ; allow-list des écritures (jamais de spread du body client) ; 401 TenantError sur toute route session ; res.ok + échec visible côté client ; erreurs "introuvable" → 404, valeurs hors enum → 400.
- AUCUN appel de modèle dans l'app. AUCUNE clé de provider stockée. L'extraction des sources = l'agent. Les lanes = le CLI local configuré par l'utilisateur.
- UI en français. Design system Task W1 OBLIGATOIRE pour toute surface : zéro couleur Tailwind brute (`red-600`, `amber-50`…) hors tokens définis dans globals.css. Chiffres en `tabular-nums`. Labels de tuiles en uppercase 11px.
- Références visuelles (qualité cible, PAS à copier pixel par pixel) : `.superpowers/design-refs/f01.png` (tuiles KPI + cards pipelines + sidebar chat), `f26.png` (densité des stats), `f33.png` (onglet resources, chips de filtres). Gitignorées, jamais commitées.
- Le repo est PUBLIC (origin). Aucun secret, aucune référence business perso dans le code, les commentaires ou les commits.
- Migrations : `npm run db:generate && npm run db:migrate` après tout changement de schéma ; le globalSetup migre la db de test.

## File Structure (ajouts de la vague)

```
src/app/globals.css                    # + tokens cockpit (Task W1)
src/components/cockpit/tile.tsx        # KPI tile · gauge-bar.tsx · section-card.tsx
src/components/cockpit/status-badge.tsx  # badge statut unifié (idea/content/source)
src/app/(app)/layout.tsx               # shell refondu : header dense (jauges, coût, nav)
src/lib/sources.ts                     # Phase A
src/app/api/ideas/[id]/sources/route.ts  src/app/api/clip/route.ts
extension/manifest.json  extension/popup.html  extension/popup.js  extension/background.js
src/lib/funnel.ts  src/app/api/stats/funnel/route.ts   # Phase B
src/components/cockpit/funnel-line.tsx
src/lib/gauges.ts  src/app/api/gauges/route.ts  src/app/api/gauges/[id]/route.ts  # Phase C
src/components/cockpit/subscription-gauges.tsx
src/lib/lanes.ts  src/lib/lane-runner.ts               # Phase D
src/app/api/lanes/route.ts  src/app/api/lanes/[id]/messages/route.ts
src/components/cockpit/chat-drawer.tsx
tests/sources.test.ts  tests/clip.test.ts  tests/funnel.test.ts
tests/gauges.test.ts  tests/lanes.test.ts  tests/fixtures/fake-cli.sh
```

---

### Task W1: Design system cockpit + refonte du shell

**Files:**
- Modify: `src/app/globals.css`, `src/app/(app)/layout.tsx`, toutes les pages existantes (`(app)/page.tsx`, `ideas/[id]`, `contents/[id]`, `settings/tokens`), `(auth)/login`, `(auth)/register`
- Create: `src/components/cockpit/tile.tsx`, `src/components/cockpit/gauge-bar.tsx`, `src/components/cockpit/section-card.tsx`, `src/components/cockpit/status-badge.tsx`

**Interfaces:**
- Produces (contrats consommés par W3/W7/W9/W11) :
  - `<Tile label value hint? tone?="default|accent|success|warning" />` — label uppercase 11px `tracking-widest text-muted`, valeur 28px `font-semibold tabular-nums`, hint 12px muted.
  - `<GaugeBar segments={[{id, percent, available}]} label reset? />` — barre 4px arrondie, segments côte à côte (multi-comptes), couleur par remplissage : <60 accent doux, 60-85 warning, >85 danger ; compte indisponible = segment hachuré/gris.
  - `<SectionCard title icon? actions? badge?>` — carte `bg-surface border border-line rounded-xl p-5`, hover `border-line-strong`, header avec titre 14px semibold + zone actions à droite.
  - `<StatusBadge kind="idea|content|source" value />` — pill uppercase 10px, mapping couleur UNIQUE pour tout l'app (draft=muted, review=warning, approved=accent, published=success, rejected=danger, pending=muted, extracted=success, failed=danger, inbox=muted, in_progress=accent, done=success, archived=muted).

- [ ] **Step 1: Tokens dans globals.css** — étendre le `@theme` Tailwind v4 existant avec les variables cockpit (et SUPPRIMER les couleurs brutes restantes des pages en les remplaçant) :

```css
@theme {
  --color-bg: #0a0a0c;            /* fond de page */
  --color-surface: #131317;       /* cartes */
  --color-raised: #1b1b21;        /* éléments sur carte (inputs, chips) */
  --color-line: #26262e;          /* bordures */
  --color-line-strong: #34343e;
  --color-ink: #e8e8ec;           /* texte principal */
  --color-muted: #8b8b95;         /* texte secondaire */
  --color-faint: #55555e;
  --color-accent: #ff4d36;        /* action/actif (corail) */
  --color-accent-soft: #ff4d3626;
  --color-success: #3dd68c;
  --color-warning: #ffb224;
  --color-danger: #ff5d5d;
}
```

Le thème est SOMBRE PAR DÉFAUT (plus de variantes claires : c'est un cockpit). `body { background: var(--color-bg); color: var(--color-ink); }`. Adapter les composants shadcn existants (button/badge/input) via leurs variables CSS (`--background`, `--primary`…) pour qu'ils héritent des tokens — pas de fork des fichiers shadcn.

- [ ] **Step 2: Les 4 composants cockpit** — code complet, props typées, AUCUNE couleur hors tokens. `GaugeBar` : segments en flex, chaque segment `title` avec le détail au survol.

- [ ] **Step 3: Shell** — `(app)/layout.tsx` refondu : header sticky `bg-bg/90 backdrop-blur border-b border-line` contenant : wordmark (point accent + nom), zone jauges (vide pour l'instant — W9 la remplit, prévoir `<div id?>` par composition : le layout accepte un slot ou rend le composant jauges quand il existera), nav (Idées / Tokens MCP), à droite l'email de session + déconnexion. Contenu `max-w-6xl mx-auto px-6 py-8`.

- [ ] **Step 4: Refonte des pages existantes** avec les composants : inbox = grille de cards idées (titre, StatusBadge, compte de contenus) + formulaire en SectionCard ; page idée = SectionCard par bloc ; page contenu = header dense (canal + StatusBadge + boutons statut en chips `bg-raised`) ; l'éditeur garde ses styles ProseMirror ; page tokens = SectionCard + le bandeau token frais passe des couleurs amber brutes à `bg-accent-soft border-accent/40`. Les `text-red-600` d'erreurs → `text-danger`.

- [ ] **Step 5: Vérifier** — `npm run build` passe ; `npx vitest run` reste à 27 ; `npx tsc --noEmit` propre ; dev server : chaque page rendue et lisible (vérif manuelle, screenshots dans le rapport si possible via navigateur, sinon décrire). Comparer mentalement aux refs `.superpowers/design-refs/` : densité, hiérarchie, calme. Commit : `feat(ui): design system cockpit — tokens, tuiles, jauges, refonte du shell et des pages`.

---

### Task W2: Sources — schéma, lib, MCP

**Files:**
- Modify: `src/lib/db/schema.ts`, `src/app/api/[transport]/route.ts`
- Create: `src/lib/sources.ts`
- Test: `tests/sources.test.ts`

**Interfaces:**
- Produces :
  - Table `sources` (voir Step 1).
  - `addSource(workspaceId, {ideaId, kind, ref, title?, rawExcerpt?, createdBy?})` — vérifie que l'idée appartient au workspace (throw `idée introuvable dans ce workspace`), kind ∈ url|text (pdf/audio/video refusés en v1 : throw `kind non disponible en v1`), construction explicite des champs (JAMAIS de spread).
  - `listSources(workspaceId, {ideaId?, status?})` ; `getSource(workspaceId, id)` → null hors workspace.
  - `attachExtraction(workspaceId, sourceId, {extractedText, extractedMeta?})` — status→extracted ; `markSourceFailed(workspaceId, sourceId, reason)` — status→failed, reason dans extractedMeta.error.
  - MCP : `list_sources(status?)`, `get_source(source_id)`, `add_source(idea_id, kind, ref, title?, raw_excerpt?)`, `attach_extraction(source_id, extracted_text, extracted_meta?)` — tous scopés par `wsOf`, mêmes patterns que les 9 outils existants ; `get_idea` inclut désormais `sources: [{id, kind, title, status}]`.

- [ ] **Step 1: Schéma**

```ts
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id").notNull()
    .references(() => ideas.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["url", "pdf", "audio", "video", "text"] }).notNull(),
  ref: text("ref").notNull(),
  title: text("title").notNull().default(""),
  rawExcerpt: text("raw_excerpt").notNull().default(""),
  extractedText: text("extracted_text").notNull().default(""),
  extractedMeta: jsonb("extracted_meta").notNull().default({}),
  status: text("status", { enum: ["pending", "extracted", "failed"] })
    .notNull().default("pending"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [index("sources_ws").on(t.workspaceId), index("sources_idea").on(t.ideaId)]);
```

`npm run db:generate && npm run db:migrate`.

- [ ] **Step 2: Tests d'abord** (`tests/sources.test.ts`, import `signUpTestUser` depuis `./helpers`) : cycle complet pending→extracted via lib ; cloisonnement (source de A invisible de B, addSource sur idée de B → throw) ; kind pdf → throw v1 ; markSourceFailed pose failed + raison. Vérifier l'échec (`npx vitest run tests/sources.test.ts`), implémenter `src/lib/sources.ts`, vert.

- [ ] **Step 3: MCP** — enregistrer les 4 outils dans `src/app/api/[transport]/route.ts` (registerTool, pattern existant) ; `get_idea` enrichi. Vérif curl JSON-RPC : `tools/list` → 13 outils ; `add_source` + `attach_extraction` bout en bout avec un token réel sur la db de dev.

- [ ] **Step 4: Suite entière + tsc + commit** — compte attendu : 27 + tes nouveaux (annonce le chiffre exact). Commit : `feat(sources): drop-anything — cycle pending→extracted, l'agent extrait, l'outil stocke`.

---

### Task W3: Sources — UI page idée + inbox

**Files:**
- Modify: `src/app/(app)/ideas/[id]/page.tsx`, `src/app/(app)/page.tsx`
- Create: `src/app/api/ideas/[id]/sources/route.ts`

**Interfaces:**
- Consumes: W1 (SectionCard, StatusBadge), W2 (lib sources).
- Produces: `GET /api/ideas/[id]/sources` (liste), `POST` (body `{kind, ref, title?, rawExcerpt?}` allow-listé, kind url|text seulement, 400 sinon, 404 idée hors workspace, 401 TenantError).

- [ ] **Step 1: Routes** (gabarit tenant identique aux routes ideas). **Step 2: UI** — sur la page idée, SectionCard « Sources » : input URL + zone texte collé, bouton Ajouter (res.ok + erreur visible), liste avec StatusBadge (pending pulse léger), `extracted` dépliable (extrait des 500 premiers caractères). Inbox : chaque card idée affiche `N sources · M contenus` en 12px muted. **Step 3:** build + tsc + suite stable + vérif manuelle dev + commit `feat(sources): dépôt et suivi des sources sur l'idée`.

---

### Task W4: POST /api/clip

**Files:**
- Create: `src/app/api/clip/route.ts`
- Test: `tests/clip.test.ts`

**Interfaces:**
- Consumes: `resolveMcpToken` (le clipper est un client-token, pas une session), `createIdea`, `addSource`.
- Produces: `POST /api/clip`, `Authorization: Bearer cs_…`, body `{url, title?, selection?}` → crée `idea` (title = title ?? url, status inbox, createdBy "clipper") + `source` (kind url, ref=url, rawExcerpt=selection ?? "") en une transaction ; rend `{ideaId, sourceId}` ; 401 sans token valide ; 400 sans url http(s) valide.

- [ ] **Step 1: Tests d'abord** : 401 sans token ; 400 url invalide (`javascript:…`, vide) ; nominal → idea+source dans le BON workspace ; le token du workspace A ne crée jamais rien chez B. **Step 2: Implémenter** (transaction, allow-list, validation URL par `new URL()` + protocole http/https). **Step 3:** suite + tsc + commit `feat(clip): endpoint de clipping authentifié par token — idée + source en un geste`.

---

### Task W5: Extension Chrome (MV3)

**Files:**
- Create: `extension/manifest.json`, `extension/popup.html`, `extension/popup.js`, `extension/background.js`, `extension/icon128.png` (généré : carré `#ff4d36` arrondi, initiale blanche — ImageMagick ou canvas Node), section README « Extension ».

**Interfaces:**
- Consumes: `POST /api/clip` (W4).
- Produces: extension chargeable en mode développeur. Popup : champs URL d'instance + token (persistés `chrome.storage.local`), bouton « Clipper cette page » (URL + titre de l'onglet actif + sélection si présente via `chrome.scripting.executeScript` → `getSelection().toString()`), état succès/erreur visible dans le popup. Menu contextuel « Clipper la sélection » (service worker, `contextMenus`) → même POST. Permissions minimales : `activeTab`, `scripting`, `storage`, `contextMenus` — PAS de `host_permissions` large (le fetch part du popup/service worker vers l'instance configurée ; ajouter `optional_host_permissions` si le fetch cross-origin l'exige, demandées au moment de la config).

- [ ] **Step 1:** manifest + popup + background complets (vanilla JS, tokens design en CSS inline du popup : fond #131317, accent #ff4d36 — cohérent cockpit). **Step 2: Vérification réelle** : `npm run dev` + charger l'extension dans un Chrome local (`--load-extension` via CLI si possible, sinon documenter pas-à-pas la vérif manuelle faite) et cliper une page réelle → l'idée apparaît avec sa source ; à minima tester le POST du popup via node en simulant son fetch exact. **Step 3:** README + commit `feat(extension): clipper Chrome MV3 — page ou sélection vers l'inbox en un clic`.

---

### Task W6: Statut rejected + funnel (lib + API)

**Files:**
- Modify: `src/lib/db/schema.ts` (enum contents.status + "rejected"), `src/app/api/contents/[id]/route.ts` (allowlist + "rejected"), `src/lib/contents.ts` (type), page contenu (chip Rejeter, tone danger)
- Create: `src/lib/funnel.ts`, `src/app/api/stats/funnel/route.ts`
- Test: `tests/funnel.test.ts`

**Interfaces:**
- Produces: `computeFunnel(workspaceId): Promise<Array<{channelKey, channelName, ideas, drafts, inReview, published, rejected, bottleneck: null | string}>>` — par canal du workspace : `ideas` = idées distinctes ayant ≥1 contenu sur ce canal, `drafts`/`inReview`/`published`/`rejected` = comptes par statut (approved compté dans inReview ? NON : colonne propre omise en affichage, approved compté avec published dans la ligne ? — DÉCISION : la ligne affiche draft/review/approved/published/rejected TELS QUELS, pas de regroupement), `bottleneck` = `"N contenus en review depuis plus de 7 jours"` si ≥1 contenu review avec `updatedAt < now()-7j`, sinon null. `GET /api/stats/funnel` → le tableau, session requise.

- [ ] **Step 1:** migration enum (`rejected`). Drizzle text-enum = pas de type PG à altérer, mais VÉRIFIER que la migration générée est vide/anodine avant apply. **Step 2: Tests d'abord** sur fixture construite (2 canaux, statuts variés, un review vieilli — poser `updatedAt` directement) : agrégat exact + bottleneck + cloisonnement. **Step 3:** lib (UNE requête groupée par canal+statut, pas N+1) + route + chip « Rejeter » sur la page contenu. **Step 4:** suite + tsc + commit `feat(funnel): agrégat par canal avec quality gate visible (rejected) et détection de goulot`.

---

### Task W7: Funnel — UI

**Files:**
- Create: `src/components/cockpit/funnel-line.tsx`
- Modify: `src/app/(app)/page.tsx`

**Interfaces:** consumes W1 + `GET /api/stats/funnel`.

- [ ] SectionCard « Pipeline » en tête d'inbox : une `FunnelLine` par canal — nom du canal, puis `12 idées → 8 drafts → 3 review → 1 approuvé → 5 publiés · 2 rejetés` en `tabular-nums` (segments muted, published en success, rejected en danger, séparateur ·) ; dessous, 12px : `✓ aucun goulot` (success) ou le message de goulot (warning). Skeleton pendant le fetch, res.ok. Build + suite stable + commit `feat(funnel): la ligne de pipeline par canal dans l'inbox`.

---

### Task W8: Jauges — schéma, poller, API

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `src/lib/gauges.ts`, `src/app/api/gauges/route.ts`, `src/app/api/gauges/[id]/route.ts`
- Test: `tests/gauges.test.ts`

**Interfaces:**
- Produces :
  - Table `gauge_sources` : id, workspaceId (FK cascade), name, url, headers jsonb default {}, kind enum quota|cost, enabled bool default true, lastPayload jsonb default {}, lastFetchedAt timestamp null, lastError text null.
  - `fetchGaugeSource(source): Promise<{payload} | {error}>` — GET `source.url` avec `source.headers`, timeout 4 s (AbortController), parse et VALIDE le contrat : `{accounts?: [{id: string, usedPercent?: number|null, resetAt?: string|null, available?: boolean}], costMonthlyEur?: number}` — champs inconnus ignorés, types faux → error. JAMAIS de throw vers l'appelant.
  - `refreshGauges(workspaceId)` — polle toutes les sources enabled du workspace (Promise.allSettled), persiste lastPayload/lastError/lastFetchedAt, rend l'état complet. Appelé par `GET /api/gauges?refresh=1` ; sans refresh → l'état stocké si `lastFetchedAt < 5 min`, sinon refresh automatique. PAS de cron : le polling est déclenché par l'affichage (l'app est single-node, un header ouvert = un refresh max/5 min).
  - Routes : `GET /api/gauges` (état agrégé : sources + payloads + coût total = somme des costMonthlyEur), `POST /api/gauges` (créer : name, url, headers?, kind — allow-list, URL http(s) validée), `PATCH/DELETE /api/gauges/[id]` (enabled/suppression, scopé workspace). Session requise partout.
  - SÉCURITÉ SSRF : refuser à la création les URL pointant vers des IP littérales privées évidentes (127.*, 10.*, 192.168.*, 169.254.*) SAUF localhost/127.0.0.1 explicitement AUTORISÉS (self-host : les bridges locaux sont le cas d'usage) — documenter dans le code : la protection réelle d'un déploiement SaaS = egress réseau, pas cette liste.

- [ ] **Step 1: Tests d'abord** avec un mini-serveur http local monté dans le test (node:http éphémère) : payload conforme (multi-comptes) → parsé ; malformé → lastError posé sans throw ; timeout (handler qui ne répond pas) → error en <5 s ; cloisonnement des routes. **Step 2:** schéma + migration + lib + routes. **Step 3:** suite + tsc + commit `feat(gauges): sources de jauges configurables — le cockpit lit tes bridges, il ne connaît aucun provider`.

---

### Task W9: Jauges — UI header + config

**Files:**
- Create: `src/components/cockpit/subscription-gauges.tsx`, `src/app/(app)/settings/gauges/page.tsx`
- Modify: `src/app/(app)/layout.tsx` (slot header), nav (lien Réglages → jauges)

**Interfaces:** consumes W1 (GaugeBar, Tile), W8.

- [ ] Header : pour chaque source quota → `GaugeBar` (segments = accounts[], label = name, reset = min des resetAt) ; à droite une `Tile` compacte « coût / mois » (somme + « configurer » si vide). Auto-refresh au montage puis toutes les 5 min (setInterval nettoyé). Source en erreur → jauge grise + tooltip lastError, JAMAIS un crash du header. Page réglages : liste + formulaire (name, url, headers JSON optionnel, kind) + toggle enabled + suppression (échec visible, convention T9). Build + suite + commit `feat(gauges): jauges multi-comptes dans le header + réglages`.

---

### Task W10: Lanes — schéma, runner CLI, API

**Files:**
- Modify: `src/lib/db/schema.ts`
- Create: `src/lib/lanes.ts`, `src/lib/lane-runner.ts`, `src/app/api/lanes/route.ts`, `src/app/api/lanes/[id]/messages/route.ts`, `tests/fixtures/fake-cli.sh`
- Test: `tests/lanes.test.ts`

**Interfaces:**
- Produces :
  - Tables : `chat_lanes` (id, workspaceId FK, title default "Conversation", cliSessionId text null, status enum idle|running|error default idle, createdAt) ; `chat_messages` (id, laneId FK cascade, role enum user|agent|system, body text, createdAt).
  - Réglage workspace : table `workspace_settings` (workspaceId PK/FK, laneCommand text default `claude -p --output-format stream-json --verbose`) — la commande est TOUJOURS configurable, jamais en dur ; page réglages l'expose (W11).
  - `lane-runner.ts` : `runLaneMessage({workspaceId, laneId, userMessage, onEvent})` — persiste le message user ; spawne la commande configurée (`child_process.spawn` via `sh -c`, message passé en argument, `--resume <cliSessionId>` ajouté si la lane en a un) ; parse le stream-json ligne à ligne : événement `init`/`system` portant session_id → persisté sur la lane ; événements assistant → texte accumulé, `onEvent({type:"chunk", text})` ; fin de process → message agent persisté, `onEvent({type:"done"})`, status idle ; exit ≠ 0 → message system d'erreur, status error. UNE exécution à la fois par lane (verrou en mémoire Map globalThis ; requête concurrente → 409).
  - Broadcast : chaque `onEvent` publie sur le bus SSE existant `{type: "lane.message", laneId, …}` (étendre `WorkspaceEvent`).
  - Routes : `GET/POST /api/lanes` (lister ; créer {title?}), `GET /api/lanes/[id]/messages` (historique), `POST /api/lanes/[id]/messages` {body} → lance runLaneMessage, répond `{accepted:true}` immédiatement (le flux arrive par SSE), 409 si running. Session requise, cloisonnement partout.
  - `tests/fixtures/fake-cli.sh` (chmod +x) : émet du stream-json déterministe — une ligne init avec session_id fixe, deux chunks assistant, exit 0 ; variante `FAKE_CLI_FAIL=1` → exit 1. Les tests configurent `laneCommand` vers cette fixture : AUCUN vrai CLI dans les tests.

- [ ] **Step 1: Tests d'abord** (fixture) : cycle complet message→chunks→done, session_id persisté, --resume présent au 2e message (la fixture echo ses args dans un chunk pour l'asserter), erreur → status error + message system, verrou 409, cloisonnement. **Step 2:** schéma + migration + libs + routes. **Step 3: Vérification RÉELLE optionnelle mais recommandée** : une lane avec le vrai `claude -p` local sur une question triviale — documenter le résultat au rapport. **Step 4:** suite + tsc + commit `feat(lanes): conversations agent sur le CLI local — l'outil orchestre, ton abonnement travaille`.

---

### Task W11: Lanes — UI drawer + @références + resume-conv

**Files:**
- Create: `src/components/cockpit/chat-drawer.tsx`, `src/app/(app)/settings/workspace/page.tsx` (laneCommand)
- Modify: `src/app/(app)/layout.tsx` (bouton chat global), `src/app/(app)/contents/[id]/page.tsx` (bouton chat contextualisé + lien « ouvrir la conversation » sur les révisions portant lane_id), `src/lib/contents.ts` + route PATCH (authorLabel `lane:<id>` quand fourni), `src/app/api/[transport]/route.ts` (update_content accepte `lane_id?` optionnel → authorLabel)

**Interfaces:** consumes W1, W10, hook `useWorkspaceEvents` existant.

- [ ] **Step 1:** Drawer droite (480px, `bg-surface border-l border-line`, plein écran mobile) : onglets de lanes (pills numérotées + « + »), historique (bulles : user à droite `bg-raised`, agent à gauche avec markdown rendu simple, system en 12px muted), streaming live via `lane.message` (chunks concaténés), input bas + Envoyer (409 → « déjà en cours », visible). **Step 2:** `@` dans l'input ouvre un picker (idées + contenus du workspace, fetch existants) ; sélection insère `[titre](cs://idea/<id>)` et le POST du message préfixe le contexte (titre + corps tronqué 2000 chars) — le CLI reçoit du texte, pas un protocole. **Step 3:** bouton chat sur la page contenu = crée/ouvre une lane titrée du contenu avec son contexte pré-injecté ; révision dont authorLabel = `lane:<id>` → lien « ouvrir la conversation » qui ouvre le drawer sur cette lane. **Step 4:** page réglages workspace (laneCommand, avertissement « cette commande tourne sur TA machine »). Build + tsc + suite stable + vérif manuelle complète avec le vrai CLI + commit `feat(lanes): drawer de chat, @-références, retour à la conversation depuis une révision`.

---

### Task W12: Passe finale — e2e cockpit + docs

**Files:**
- Create: `tests/e2e-cockpit.test.ts`
- Modify: `README.md`

- [ ] **Step 1:** e2e lib-level du fil complet : clip (route) → source pending → agent (MCP libs) extrait → contenu créé sur community → rejeté puis nouveau publié → funnel reflète tout (1 rejected, 1 published) → une lane fixture produit une révision `lane:<id>`. **Step 2:** README : sections extension, jauges (contrat de payload documenté avec exemple), lanes (self-host only + laneCommand), captures des nouveautés si possible. **Step 3:** suite complète + build + commit `feat(cockpit): e2e du fil complet + docs de la vague`.

---

## Self-Review

Couverture spec→plan : A.1 (W2/W3), A.2 (W4/W5), B (W6/W7), C (W8/W9), D (W10/W11), qualité UI transverse (W1, contrainte globale), e2e (W12). Hors périmètre respecté : pas d'inbox findings, pas d'extraction serveur, pas de compagnon SaaS. Types inter-tasks nommés dans chaque bloc Interfaces ; conventions v1 (allow-list, 401, res.ok, 404/400) rappelées en contraintes globales. Risques laissés à l'implémenteur documentés dans les steps : migration enum W6, SSRF W8 (localhost autorisé par design self-host), verrou mémoire W10 (single-node assumé).
