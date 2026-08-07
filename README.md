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

## Tests

    npm run test    # vitest single-run, db content_studio_test

## Limites connues (v1)

- Le Dockerfile self-host copie `.next` + `node_modules` en entier (pas de
  `output: "standalone"` dans `next.config.ts`) : image plus grosse que
  nécessaire, assumé pour rester simple en v1.
