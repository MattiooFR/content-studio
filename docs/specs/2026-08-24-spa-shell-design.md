# SPA shell — salle de tri + vue pipeline

**Date** : 2026-08-24
**Décision produit** : maquettes comparées (3 pistes) puis choix utilisateur : **piste A
(« salle de tri », trois volets) comme colonne vertébrale, avec un switch vers la vue
board (piste B « pipeline »)**. Pas d'inspecteur façon piste C en v1 — les fiches détail
existantes sont réutilisées telles quelles dans le volet.

## 1. Problème

Le studio est aujourd'hui un site multi-pages : inbox `/` → fiche idée `/ideas/[id]` →
fiche contenu `/contents/[id]`, avec une navigation complète à chaque étape. L'usage
réel est un poste de pilotage : trier les propositions des agents, relire, publier —
sans jamais perdre la liste des yeux.

## 2. Cible

Une seule vue applicative plein écran sur `/` :

```
┌──────────┬───────────────┬─────────────────────────────┐
│ sidebar  │ liste (A)     │ volet détail                │
│ buckets  │ ou board (B)  │ (IdeaDetail│ContentDetail)  │
│ + jauges │               │  en vue board : tiroir      │
└──────────┴───────────────┴─────────────────────────────┘
```

- **Vue liste (défaut)** : liste d'items au centre, volet détail à droite. Cliquer un
  item remplace le volet, jamais la page.
- **Vue board** : 5 colonnes par étape (Proposé, Rédaction, Relecture, Prêt, Publié),
  les cartes avancent au fil des jobs. Cliquer une carte ouvre le **même détail** dans
  un tiroir par-dessus le board (Échap / clic hors du tiroir referme).
- Le switch liste ⇄ board est un segmented control en tête de la colonne centrale.
- **Deep-linking** : tout l'état visible vit dans l'URL (`?view=&bucket=&item=`) —
  rechargement et partage reproduisent l'écran exact.

## 3. Modèle : item et étape

Un **item** = une idée + ses contenus (tout contenu a `ideaId` not null). L'étape est
dérivée, jamais stockée — fonction pure `stageOf(idea, contents, lastJobStatus)` dans
`src/lib/stage.ts` :

| Étape (`Stage`) | Règle (première qui matche, de haut en bas) |
|---|---|
| `discarded` | idée `archived`, ou tous ses contenus `rejected` (au moins un contenu) |
| `published` | au moins un contenu `published`, ou idée `done` |
| `ready` | au moins un contenu `approved` |
| `review` | au moins un contenu `review` |
| `writing` | au moins un contenu `generating`/`draft`, ou dernier job `queued`/`running`, ou idée `in_progress` |
| `proposed` | reste (idée `inbox` sans contenu) |

Buckets de la sidebar (filtres de la vue liste, avec compteurs vivants) :

| Bucket (`?bucket=`) | Étapes couvertes | Libellé |
|---|---|---|
| `todo` (défaut) | `proposed` + `review` + `ready` | À traiter |
| `writing` | `writing` | En rédaction |
| `published` | `published` | Publiés |
| `discarded` | `discarded` | Écartés |

La vue board ignore `bucket` : elle montre toujours les 5 étapes actives
(`discarded` n'a pas de colonne — accessible via le bucket en vue liste).

## 4. Données

`listIdeas` (src/lib/ideas.ts) gagne un champ **additif** `contents` : agrégat JSON des
contenus de l'idée `[{ id, status, channelKey }]` (sous-requête `json_agg` qualifiée à
la main, même pattern que `contentsCount` — voir le commentaire existant sur le piège
drizzle de qualification). Aucune colonne existante ne bouge ; `/api/ideas` sert
désormais tout ce qu'il faut à la liste ET au board en une requête. Pas de nouvel
endpoint.

## 5. URL et état

`src/lib/workspace-url.ts` — fonctions pures :

```ts
type WorkspaceState = {
  view: "list" | "board";              // défaut "list"
  bucket: "todo" | "writing" | "published" | "discarded"; // défaut "todo"
  item: { type: "idea" | "content"; id: string } | null;  // ?item=idea:<uuid>
};
parseWorkspaceState(params: URLSearchParams): WorkspaceState  // tolérant : valeur
                                                              // inconnue → défaut
serializeWorkspaceState(s: WorkspaceState): string            // omet les défauts
```

Hook client `useWorkspaceState()` : lit `useSearchParams`, écrit via
`window.history.replaceState` (pas de re-render serveur, pas d'entrée d'historique par
sélection) sauf changement de `view` qui fait un `pushState` (retour navigateur =
retour à la vue précédente).

## 6. Composants

```
src/app/(app)/layout.tsx            — la sidebar REMPLACE le header horizontal pour
                                      toutes les pages (app) ; les pages settings
                                      s'affichent dans la zone principale
src/app/(app)/page.tsx              — la vue workspace (shell)
src/components/workspace/
  sidebar.tsx                       — logo, buckets+compteurs, liens Réglages
                                      (Jauges, Tokens MCP, Lanes), ChatLauncher,
                                      SubscriptionGauges, email+SignOut en bas
  item-list.tsx                     — vue A : lignes (titre, pill d'étape, méta),
                                      sélection contrôlée, navigation j/k
  board.tsx                         — vue B : 5 colonnes, cartes, états vides
  detail-host.tsx                   — décide IdeaDetail vs ContentDetail d'après
                                      `item`, rend inline (liste) ou en tiroir (board)
  view-switch.tsx                   — segmented control liste ⇄ board
src/components/idea-detail.tsx      — extraction de l'actuelle page /ideas/[id]
src/components/content-detail.tsx   — extraction de l'actuelle page /contents/[id]
```

**Extraction des fiches** : les deux pages sont déjà des composants client autonomes
qui fetchent tout à partir de l'id. L'extraction change uniquement :
- la prop (`{ params }` → `{ ideaId }` / `{ contentId }`) ;
- les navigations internes (`router.push("/contents/x")`, `href` des liens « ouvrir »)
  → callback `onOpenItem(item)` fourni par le shell (qui met à jour `?item=`) ;
- le `<h1>` devient un `<h2>` (le shell possède la page).
Aucune logique (autosave, SSE, résolution de révisions, relecture) ne change.

**Sélection** : cliquer un item de liste/carte de board sélectionne l'idée ; si l'idée
a au moins un contenu, on ouvre directement son contenu le plus avancé (ordre :
published > approved > review > generating > draft), sinon la fiche idée. La fiche
contenu affiche en tête un lien discret vers la fiche idée (titre de l'idée), et
inversement la fiche idée liste ses contenus (existant).

**Routes conservées** : `/ideas/[id]` et `/contents/[id]` deviennent des redirects
serveur (`redirect("/?item=idea:<id>")`) — les liens du worker, des jobs
(« Brouillon prêt → ouvrir ») et les vieux favoris continuent de marcher.

## 7. Temps réel

`useWorkspaceEvents` existant. Le shell recharge `/api/ideas` sur `idea.created`,
`job.updated`, `content.status` (les compteurs de buckets, la liste et le board sont
recalculés d'un même état). Les fiches détail gardent leurs abonnements internes
actuels, inchangés.

## 8. Responsive

- ≥ `lg` : grille 3 volets (sidebar 224px, liste 320px, volet flexible), hauteur
  100vh, chaque volet scrolle indépendamment.
- < `lg` : sidebar réduite à une barre supérieure (logo + bucket courant + menu) ;
  liste pleine largeur ; le détail s'ouvre en tiroir plein écran (même mécanique que
  le tiroir du board). Le board scrolle horizontalement.

## 9. Hors périmètre (v1)

- Palette ⌘K, inspecteur latéral façon piste C, réorganisation en onglets de la fiche
  contenu (elle garde ses sections actuelles Éditer/Relire + révisions + publication).
- Drag & drop sur le board (les statuts avancent par les jobs et les boutons).
- Rien de spécifique à un usage particulier du studio : le shell reste générique.

## 10. Tests

- `src/lib/stage.test.ts` — table de vérité de `stageOf` (chaque règle + priorités).
- `src/lib/workspace-url.test.ts` — parse/serialize : défauts, valeurs inconnues,
  aller-retour.
- `src/lib/ideas.test.ts` (existant, étendu) — le champ `contents` agrégé : forme,
  isolation par workspace.
- La suite existante (243 tests) reste verte — aucune API modifiée non additivement.
