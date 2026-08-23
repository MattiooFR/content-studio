#!/bin/sh
# Sauvegarde de la base content-studio.
#
# Dump LOGIQUE (pg_dump), pas une copie du volume : un dump se relit sur
# n'importe quelle version de postgres et se restaure base par base, alors
# qu'une copie brute de /var/lib/postgresql/data n'est relisible que par la
# même version majeure du serveur — inutilisable le jour où l'image bouge.
#
# Usage :   deploy/backup.sh
# Cron  :   30 4 * * * /home/mattioo/content-studio/deploy/backup.sh >> /home/mattioo/backups/content-studio/backup.log 2>&1
#
# Restauration d'un dump :
#   gzip -dc <fichier>.sql.gz | docker compose exec -T postgres psql -U cs -d content_studio
set -eu

DIR="${CS_DIR:-/home/mattioo/content-studio}"
OUT="${CS_BACKUP_DIR:-/home/mattioo/backups/content-studio}"
KEEP="${CS_BACKUP_KEEP:-14}"

cd "$DIR"
mkdir -p "$OUT"

# Identifiants lus dans le .env du déploiement — jamais passés en argument de
# ligne de commande, qui serait lisible par tout le monde dans `ps`.
PGUSER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || true)"
PGDB="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2- || true)"
[ -n "$PGUSER" ] || PGUSER=cs
[ -n "$PGDB" ] || PGDB=content_studio

STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT/content_studio-$STAMP.sql.gz"

# -T : pas de pseudo-TTY, sinon docker injecte des retours chariot dans le flux
# et le dump devient irrécupérable.
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" --clean --if-exists \
  | gzip -9 > "$FILE.part"
mv "$FILE.part" "$FILE"

# Vérification RÉELLE du contenu, pas seulement de l'existence du fichier :
# `sh` n'a pas de pipefail, donc un pg_dump qui meurt en cours de route
# laisserait quand même un .gz valide — juste tronqué. pg_dump écrit cette
# ligne en toute dernière position et seulement s'il est allé au bout.
if ! gzip -dc "$FILE" | tail -5 | grep -q 'PostgreSQL database dump complete'; then
  echo "[backup] ÉCHEC : dump tronqué ou vide, $FILE supprimé." >&2
  rm -f "$FILE"
  exit 1
fi

find "$OUT" -name 'content_studio-*.sql.gz' -mtime "+$KEEP" -delete
echo "[backup] OK $FILE ($(stat -c %s "$FILE") octets, rétention ${KEEP}j)"
