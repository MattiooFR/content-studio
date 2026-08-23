# syntax=docker/dockerfile:1

# ─── 1. deps ─────────────────────────────────────────────────────────────────
# node_modules COMPLET (devDependencies incluses : next, tailwind, typescript
# sont nécessaires au build). Couche volontairement isolée sur le seul couple
# package.json + package-lock.json : tant que ces deux fichiers ne bougent pas,
# `npm ci` n'est pas rejoué, même si tout src/ a changé. Le cache monté sur
# /root/.npm évite en plus de retélécharger les tarballs entre deux builds.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ─── 2. build ────────────────────────────────────────────────────────────────
# `next build` avec output: "standalone" (cf. next.config.ts) produit
# .next/standalone : un serveur node autonome accompagné du SEUL sous-ensemble
# de node_modules réellement tracé depuis le code. C'est ce qui remplace la
# copie de node_modules en entier dans l'image finale.
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ─── 3. runner ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# HOSTNAME=0.0.0.0 : le serveur standalone lit HOSTNAME/PORT (c'est l'équivalent
# du `next start -H 0.0.0.0 -p 3003` de start:docker, et non de `start`, qui
# binde le loopback). À l'intérieur du conteneur, un bind loopback serait
# injoignable par le NAT de publication de port de Docker (`-p host:container`
# route vers l'IP du conteneur sur le réseau bridge, jamais vers son 127.0.0.1
# — namespace réseau isolé). C'est le mapping HOTE, restreint à 127.0.0.1 dans
# docker-compose.yml (comme postgres), qui fait le travail de sécurité —
# vérifié empiriquement : un process bindé 127.0.0.1 en conteneur ne répond
# PAS, même via `-p 127.0.0.1:PORT:PORT`.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3003 \
    HOSTNAME=0.0.0.0

# Le serveur autonome + les assets que Next ne trace pas (ils ne sont importés
# par aucun module : .next/static est servi par URL, public/ est du fichier plat).
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Migrations. Les .sql + meta/_journal.json, et les deux paquets dont le
# migrateur a besoin : scripts/migrate.mjs ne fait pas partie du graphe d'import
# de l'app, donc Next ne garantit pas d'avoir tracé les fichiers de
# drizzle-orm/postgres-js/migrator dans .next/standalone. On les copie
# explicitement — ~16 Mo, à comparer aux ~700 Mo de node_modules complet que
# l'image précédente embarquait.
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=deps  --chown=node:node /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=deps  --chown=node:node /app/node_modules/postgres    ./node_modules/postgres
COPY --chown=node:node scripts/migrate.mjs ./scripts/migrate.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# node:22-alpine fournit déjà l'utilisateur non privilégié `node` (uid 1000).
# Tout ce que le serveur doit écrire (.next/cache) lui appartient via les
# --chown ci-dessus ; le reste de / reste root et non modifiable par l'app.
USER node

EXPOSE 3003

# Interroge vraiment l'application : /login est une page publique servie par
# Next, donc un 200 prouve que le serveur HTTP répond et rend du React — pas
# seulement que le process existe. `fetch` est global sur node 22, aucun curl
# ni wget à installer dans l'image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ENTRYPOINT (migration bloquante) + CMD (le serveur) séparés : `docker compose
# run app sh` reste possible sans rejouer les migrations à contretemps, et le
# serveur est PID 1 via exec, donc il reçoit bien SIGTERM à l'arrêt.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
