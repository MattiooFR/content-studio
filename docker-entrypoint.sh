#!/bin/sh
# Migrer, puis passer la main au serveur — jamais l'inverse, jamais l'un sans
# l'autre. `set -e` fait sortir le conteneur avec le code d'erreur du migrateur
# si celui-ci échoue : combiné à `restart: unless-stopped`, la panne est
# visible (boucle de redémarrage + trace complète dans `docker compose logs`)
# au lieu d'un serveur qui répond 200 sur une base au schéma périmé.
set -e

echo "[entrypoint] migration du schéma…"
node /app/scripts/migrate.mjs

echo "[entrypoint] démarrage du serveur Next (standalone)…"
exec "$@"
