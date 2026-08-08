#!/bin/sh
# tests/fixtures/fake-cli.sh
#
# CLI factice pour tester src/lib/lane-runner.ts SANS jamais invoquer un
# vrai agent (AUCUN vrai CLI dans les tests).
#
# Comportement par défaut : émet du stream-json déterministe, une ligne
# JSON par événement :
#   1. system/init avec un session_id FIXE — le runner doit le persister.
#   2. assistant : "argv-json: [...]" — un tableau JSON EXACT de tous les
#      argv reçus par ce script (échappés minimalement). Permet aux tests
#      d'asserter la position PRÉCISE de "--" et des tokens autour : preuve
#      que --resume est bien transmis, ET que "--" précède toujours le
#      message (jamais l'inverse — sinon un message qui ressemble à un
#      flag serait lu comme une option par le CLI cible).
#   3. assistant : un second chunk, pour vérifier l'accumulation.
#   4. exit 0.
#
# Variantes (toutes lues depuis l'environnement, jamais depuis les argv —
# c'est workspace_settings.laneCommand qui les positionne, ex.
# "FAKE_CLI_HANG=1 /chemin/fake-cli.sh") :
#   FAKE_CLI_FAIL=1        → exit 1 après l'init (chemin d'erreur).
#   FAKE_CLI_HANG=1        → dort 600 s après l'init (teste le timeout dur
#                            du runner + le kill de l'arbre + la
#                            libération du verrou).
#   FAKE_CLI_BIG_OUTPUT=1  → émet un unique chunk de ~3 MiB (teste le cap
#                            stdout du runner, qui doit couper avant la fin).
#   FAKE_CLI_FLOOD=1       → ignore SIGTERM (trap) et crache des chunks de
#                            64 Kio en boucle indéfiniment après l'init.
#                            Ne meurt QUE sur SIGKILL, après killGraceMs —
#                            simule un process qui "tarde à mourir". Teste
#                            que la lecture stdout du runner s'arrête bien
#                            AU CAP (pas juste qu'un kill est demandé) :
#                            sans ça, ce script inonderait le buffer du
#                            runner pendant toute la fenêtre de grâce.
#   FAKE_CLI_FLOOD_STDERR=1 → même scénario que FAKE_CLI_FLOOD, mais le flot
#                            va sur STDERR (>&2) au lieu de stdout. Teste
#                            que le cap stderr (Fix round 3) borne LUI AUSSI
#                            la lecture, symétriquement au cap stdout.

if [ "${FAKE_CLI_HANG:-}" = "1" ]; then
  printf '{"type":"system","subtype":"init","session_id":"fake-session-hang"}\n'
  sleep 600
  exit 0
fi

if [ "${FAKE_CLI_FLOOD:-}" = "1" ]; then
  trap '' TERM
  printf '{"type":"system","subtype":"init","session_id":"fake-session-flood"}\n'
  chunk=$(head -c 65536 /dev/zero | tr '\0' 'b')
  while true; do
    printf '%s' "$chunk"
  done
fi

if [ "${FAKE_CLI_FLOOD_STDERR:-}" = "1" ]; then
  trap '' TERM
  printf '{"type":"system","subtype":"init","session_id":"fake-session-flood-stderr"}\n'
  chunk=$(head -c 65536 /dev/zero | tr '\0' 'e')
  while true; do
    printf '%s' "$chunk" >&2
  done
fi

if [ "${FAKE_CLI_FAIL:-}" = "1" ]; then
  printf '{"type":"system","subtype":"init","session_id":"fake-session-fail"}\n'
  echo "fake-cli: échec simulé (FAKE_CLI_FAIL=1)" >&2
  exit 1
fi

if [ "${FAKE_CLI_BIG_OUTPUT:-}" = "1" ]; then
  printf '{"type":"system","subtype":"init","session_id":"fake-session-big"}\n'
  big=$(head -c 3000000 /dev/zero | tr '\0' 'a')
  printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$big"
  exit 0
fi

printf '{"type":"system","subtype":"init","session_id":"fake-session-fixed-001"}\n'

# Reconstruit un tableau JSON EXACT de "$@" (échappe juste \ et " — suffit
# pour les messages de test, ce script n'a pas vocation à être un
# encodeur JSON général).
argv_json="["
first=1
for a in "$@"; do
  if [ "$first" -eq 0 ]; then argv_json="${argv_json},"; fi
  esc=$(printf '%s' "$a" | sed 's/\\/\\\\/g; s/"/\\"/g')
  argv_json="${argv_json}\"${esc}\""
  first=0
done
argv_json="${argv_json}]"

# argv_json est lui-même un morceau de JSON (des guillemets dedans) qu'on
# embarque comme VALEUR d'un champ JSON "text" — il faut donc l'échapper
# une 2e fois (\ puis ") pour ce niveau d'imbrication, sinon ses guillemets
# internes cassent la chaîne "text" englobante et la ligne entière devient
# du JSON invalide (silencieusement avalée par le parseur tolérant du
# runner : le bug réel qui a fait disparaître ce chunk avant ce fix).
argv_json_escaped=$(printf '%s' "$argv_json" | sed 's/\\/\\\\/g; s/"/\\"/g')

printf '{"type":"assistant","message":{"content":[{"type":"text","text":"argv-json: %s"}]}}\n' "$argv_json_escaped"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":" | fin-fake-cli"}]}}\n'
exit 0
