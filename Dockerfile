FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/lib/db/schema.ts ./src/lib/db/schema.ts
EXPOSE 3003
# start:docker (0.0.0.0) et non start (127.0.0.1) : à l'intérieur du
# conteneur, un bind loopback serait injoignable par le NAT de publication
# de port de Docker (`-p host:container` route vers l'IP du conteneur sur le
# réseau bridge, jamais vers son 127.0.0.1 — namespace réseau isolé). C'est
# le mapping HOTE, restreint à 127.0.0.1 dans docker-compose.yml (comme
# postgres juste au-dessus), qui fait le travail de sécurité — vérifié
# empiriquement : un process bindé 127.0.0.1 en conteneur ne répond PAS,
# même via `-p 127.0.0.1:PORT:PORT`.
CMD ["sh", "-c", "npx drizzle-kit migrate && npm run start:docker"]
