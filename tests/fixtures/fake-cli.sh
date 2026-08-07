#!/bin/sh
# tests/fixtures/fake-cli.sh
#
# CLI factice pour tester src/lib/lane-runner.ts SANS jamais invoquer un
# vrai agent (AUCUN vrai CLI dans les tests). Émet du stream-json
# déterministe, une ligne JSON par événement :
#
#   1. system/init avec un session_id FIXE — le runner doit le persister
#      sur la lane.
#   2. assistant : "args-recus: <tous les argv reçus par ce script>" — les
#      tests lisent ce texte pour prouver que --resume <cliSessionId> est
#      bien transmis au 2e message d'une lane.
#   3. assistant : un second chunk, pour vérifier l'accumulation des
#      chunks en un seul message agent.
#   4. exit 0.
#
# FAKE_CLI_FAIL=1 (positionnée dans workspace_settings.laneCommand, ex.
# "FAKE_CLI_FAIL=1 /chemin/vers/fake-cli.sh") : simule un crash — émet
# quand même l'init, écrit sur stderr, puis exit 1. Teste le chemin
# d'erreur du runner (message system + status error).

if [ "${FAKE_CLI_FAIL:-}" = "1" ]; then
  printf '{"type":"system","subtype":"init","session_id":"fake-session-fail"}\n'
  echo "fake-cli: échec simulé (FAKE_CLI_FAIL=1)" >&2
  exit 1
fi

printf '{"type":"system","subtype":"init","session_id":"fake-session-fixed-001"}\n'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"args-recus: %s"}]}}\n' "$*"
printf '{"type":"assistant","message":{"content":[{"type":"text","text":" | fin-fake-cli"}]}}\n'
exit 0
