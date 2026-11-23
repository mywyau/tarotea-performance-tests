#!/usr/bin/env bash

set -euo pipefail

if [[ "${APPROVE_READ_ONLY_SMOKE:-}" != "yes" ]]; then
  echo "Refusing to create traffic. Set APPROVE_READ_ONLY_SMOKE=yes after deployment approval." >&2
  exit 2
fi

if [[ -z "${BASE_URL:-}" ]]; then
  echo "BASE_URL is required." >&2
  exit 2
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required but was not found on PATH." >&2
  exit 127
fi

RUN_ID="${RUN_ID:-$(date -u +%Y-%m-%dT%H%MZ)}"
TOPIC_SLUG="${TOPIC_SLUG:-survival-essentials}"
LEVEL_SLUG="${LEVEL_SLUG:-level-one}"

mkdir -p reports

echo "Running read-only post-deploy smoke against ${BASE_URL} (${RUN_ID})"

k6 run performance/k6/smoke-safe-get.js \
  -e BASE_URL="${BASE_URL}" \
  -e TOPIC_SLUG="${TOPIC_SLUG}" \
  -e LEVEL_SLUG="${LEVEL_SLUG}" \
  -e VUS=1 \
  --summary-export="reports/${RUN_ID}-smoke.json"

k6 run performance/k6/cache-boundary-check.js \
  -e BASE_URL="${BASE_URL}" \
  -e TOPIC_SLUG="${TOPIC_SLUG}" \
  -e LEVEL_SLUG="${LEVEL_SLUG}" \
  --summary-export="reports/${RUN_ID}-cache-boundary.json"

if [[ "${RUN_AUTH_CHECK:-no}" == "yes" ]]; then
  k6 run performance/k6/auth-flow-check.js \
    -e BASE_URL="${BASE_URL}" \
    --summary-export="reports/${RUN_ID}-auth.json"
fi

echo "Post-deploy smoke passed. Summaries use prefix reports/${RUN_ID}-"
