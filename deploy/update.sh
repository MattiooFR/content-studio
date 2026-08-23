#!/bin/sh
# Mise à jour du déploiement, en une commande :
#   ssh mattioo@144.76.224.57 '~/content-studio/deploy/update.sh'
set -eu
cd "${CS_DIR:-/home/mattioo/content-studio}"

APP_PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2- || true)"
[ -n "$APP_PORT" ] || APP_PORT=3003

echo "[update] récupération de origin…"
git fetch origin

# rebase plutôt que merge : tant que le commit de packaging Docker n'est pas
# poussé sur origin/main, il vit en local sur le serveur. `git rebase` le
# rejoue par-dessus les nouveautés — et le jour où le même patch arrive sur
# origin, git le détecte (patch-id) et le laisse tomber tout seul. La même
# commande marche donc avant ET après le push, sans intervention.
echo "[update] rebase sur origin/main…"
if ! git rebase origin/main; then
  git rebase --abort >/dev/null 2>&1 || true
  echo "[update] ÉCHEC : conflit de rebase. Rien n'a été déployé, l'app tourne" >&2
  echo "         toujours dans sa version précédente. À régler à la main." >&2
  exit 1
fi

echo "[update] build + redémarrage…"
docker compose up -d --build

# Ne pas s'arrêter à « le conteneur est up » : on attend le healthcheck (qui
# interroge vraiment /login) puis on refait un appel HTTP depuis l'hôte. Une
# migration en échec fait sortir le conteneur en erreur : on le verrait ici.
echo "[update] attente du healthcheck…"
i=0
until [ "$(docker inspect --format '{{.State.Health.Status}}' content-studio-app-1 2>/dev/null)" = "healthy" ]; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[update] ÉCHEC : toujours pas healthy après 3 min. Logs :" >&2
    docker compose logs --tail 40 app >&2
    exit 1
  fi
  sleep 3
done

CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/login")"
[ "$CODE" = "200" ] || { echo "[update] ÉCHEC : /login répond $CODE." >&2; exit 1; }

echo "[update] OK — $(git log --oneline -1)"
docker compose ps --format 'table {{.Name}}\t{{.Status}}'
