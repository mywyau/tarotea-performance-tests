# Manifest-driven k6 tests

These tests use `endpoints.json` as the source of truth and skip endpoints where `safeForLoadTest` is `false`.

Run commands from the repo root:

```sh
cd /Users/michael.yau/tarotea/tarotea-performance-tests
```

Production runs require explicit approval. Before a baseline, copy
`reports/baseline-template.md` to a dated report and record the deployment,
provider dashboards, and stop conditions there.

## Post-deploy release gate

After an approved production deployment, run the read-only smoke and cache
isolation checks together:

```sh
APPROVE_READ_ONLY_SMOKE=yes \
BASE_URL=https://www.tarotea.co.uk \
./scripts/post-deploy-smoke.sh
```

The script requires the explicit approval flag, uses one virtual user, stops on
the first failed gate, and writes dated summaries under `reports/`. Add
`RUN_AUTH_CHECK=yes` to include the authenticated boundary when valid generated
test tokens are available. It never runs completion journeys or writes learner
progress.

## Auth tokens

The tests can authenticate in four ways:

- `AUTH_TOKEN`: one bearer token for every virtual user.
- `AUTH_TOKENS`: comma-separated bearer tokens, rotated by VU and iteration.
- `AUTH_TOKENS_FILE`: path to a JSON array of tokens.
- `SESSION_COOKIE`: browser session cookie, used when bearer tokens are not appropriate.

By default, tests look for generated Auth0 tokens at `auth/tokens.json`.

Generate or refresh that file with:

```sh
USER_COUNT=50 APP_BASE_URL=https://www.tarotea.co.uk node auth/generate-test-tokens.mjs
```

For Grafana Cloud local execution, `auth/tokens.json` is available because the script still runs on your machine.
For full cloud execution, pass tokens explicitly:

```sh
-e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

## Running In Grafana Cloud

Use local execution first. It runs load from your machine and streams results to Grafana Cloud:

```sh
k6 cloud login
```

```sh
k6 cloud run --local-execution <script> \
  -e BASE_URL=https://www.tarotea.co.uk
```

Full cloud execution runs from Grafana infrastructure:

```sh
k6 cloud run <script> \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

## Smoke Safe GET Endpoints

Read-only smoke test for safe `GET` endpoints.

Local:

```sh
k6 run performance/k6/smoke-safe-get.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials
```

Grafana Cloud, local execution:

```sh
k6 cloud run --local-execution performance/k6/smoke-safe-get.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials
```

Grafana Cloud, full cloud execution:

```sh
k6 cloud run performance/k6/smoke-safe-get.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

## Learner Journey

Read-heavy learner flow: public discovery, content browsing, safe quiz starts, dashboard reads, and authenticated practice starts. It does not finalize quizzes or dojo sessions.

Local:

```sh
k6 run performance/k6/learner-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1
```

Grafana Cloud, local execution:

```sh
k6 cloud run --local-execution performance/k6/learner-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1
```

Grafana Cloud, full cloud execution:

```sh
k6 cloud run performance/k6/learner-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

`LEVEL` can be numeric (`1`, `8`) or `LEVEL_SLUG` can be passed directly (`level-one`, `level-eight`).

## Cache Boundary Check

Low-volume post-deploy check for cache isolation. It verifies the cookie-aware HTML shell forbids shared caching, deterministic content permits bounded shared caching, quiz and user responses remain private/no-store, and missing content is not publicly cached.

```sh
k6 run performance/k6/cache-boundary-check.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL_SLUG=level-one
```

Add `AUTH_TOKEN`, `AUTH_TOKENS`, or `AUTH_TOKENS_FILE` to include the authenticated user boundary. This script makes only one request per boundary and does not mutate application data.

## Auth Flow Check

Production-safe auth boundary check. It verifies missing auth returns `401`, malformed bearer tokens return `401`, generated tokens can call `/api/meV2`, and generated tokens can access protected read endpoints.

Local:

```sh
k6 run performance/k6/auth-flow-check.js \
  -e BASE_URL=https://www.tarotea.co.uk
```

Grafana Cloud, local execution:

```sh
k6 cloud run --local-execution performance/k6/auth-flow-check.js \
  -e BASE_URL=https://www.tarotea.co.uk
```

Grafana Cloud, full cloud execution:

```sh
k6 cloud run performance/k6/auth-flow-check.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

Optional post-login check:

```sh
k6 run performance/k6/auth-flow-check.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e CHECK_POST_LOGIN=true
```

`CHECK_POST_LOGIN=true` calls `/api/auth/post-login`; keep it low-volume in production.

## Quiz Completion Journey

Mutating test. It starts and finalizes topic word, topic sentence, and level sentence quizzes. It writes progress and can enqueue background XP work.

Local:

```sh
k6 run performance/k6/quiz-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1
```

Grafana Cloud, local execution:

```sh
k6 cloud run --local-execution performance/k6/quiz-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1
```

Grafana Cloud, full cloud execution:

```sh
k6 cloud run performance/k6/quiz-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1 \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

Start with `TARGET_VUS=1` in production because this mutates learner state and can hit per-user rate limits.

## Dojo Completion Journey

Mutating test. It starts and finalizes topic word, level word, topic sentence, and level sentence dojo sessions. It writes progress and can enqueue background XP work.

Local:

```sh
k6 run performance/k6/dojo-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1
```

Grafana Cloud, local execution:

```sh
k6 cloud run --local-execution performance/k6/dojo-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1
```

Grafana Cloud, full cloud execution:

```sh
k6 cloud run performance/k6/dojo-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1 \
  -e AUTH_TOKENS="$(jq -r 'join(",")' auth/tokens.json)"
```

Run a subset of dojo flows:

```sh
k6 run performance/k6/dojo-completion-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e DOJO_FLOWS=topic-jyutping,level-sentence
```

Default flows: `topic-jyutping`, `topic-chinese`, `level-jyutping`, `level-chinese`, `topic-sentence`, `level-sentence`.

`ANSWER_MODE` can be `mixed`, `correct`, `wrong`, or `random`. `HINT_RATE` controls the fraction of attempts marked as hint-assisted, defaulting to `0.1`.

## Debugging Unexpected Statuses

Print unexpected statuses during a run:

```sh
k6 run performance/k6/smoke-safe-get.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LOG_UNEXPECTED_STATUSES=true \
  -e UNEXPECTED_STATUS_LOG_LIMIT=50
```

The main custom metrics are:

- `endpoint_status_count`: responses tagged by endpoint, category, method, path, and status.
- `endpoint_unexpected_status_rate`: responses with status `>=400`.
- `auth_flow_unexpected_status_rate`: auth check responses outside expected statuses.

## Guest and signed-in baselines

Select `LEARNER_MODE=guest` for anonymous traffic, including when token files
exist. Use `LEARNER_MODE=signed-in` with dedicated bearer tokens to include the
dashboard. The read journey visits Word of the Day, the learner count, public
content and guest-accessible quiz and typing starts. Set
`DAILY_PRACTICE_ENABLED=true` only when testing a deployment with daily practice
enabled. The existing rapid quiz and dojo completion loops remain stress tests.

## Practice capacity and XP correctness (staging)

Run against a staging deployment with its own DB, Redis, Auth0 test accounts
and QStash workers pointing back to staging. The two new scripts also accept a
local test server. Start with one learner. The capacity script requires an
explicit guest or signed-in mode. Signed-in capacity runs need one token per
allocated VU from distinct dedicated accounts. The retry check needs one
exclusive learner whose progress is not touched by another run.

    k6 run -e BASE_URL="$STAGING_URL" -e LEARNER_MODE=guest -e TARGET_VUS=1 performance/k6/practice-capacity.js
    k6 run -e BASE_URL="$STAGING_URL" -e LEARNER_MODE=signed-in -e AUTH_TOKENS_FILE="$TEST_TOKENS_FILE" -e TARGET_VUS=1 performance/k6/practice-capacity.js
    k6 run -e BASE_URL="$STAGING_URL" -e AUTH_TOKENS_FILE="$TEST_TOKENS_FILE" performance/k6/xp-retry-check.js

The paced profile ramps to TARGET_VUS over RAMP_UP (10m), then holds for
STEADY_STATE (20m). It alternates topic vocabulary quizzes and Chinese typing,
waits SESSION_SECONDS (600 by default, with ±20% variation), and saves once for
signed-in learners. Guest completion is local. It models the practice API
workload; audio CDN throughput and browser rendering are measured separately.

For a coordinated class, use PROFILE=burst, STARTS_PER_SECOND and BURST_SECONDS.
For example, 50 starts/second for 60 seconds with SESSION_SECONDS=600 targets
3,000 overlapping sessions followed by a corresponding minute of finishes.
Each arrival is one session, with no per-question API calls. The driver must
have capacity for the allocated VUs. A dropped iteration fails the burst.
Start small (e.g. 1 start/s for 2 seconds), then increase in measured stages.
At 3,000 steady concurrent learners, ten-minute sessions imply roughly five
starts and five completions per second.

Both profiles emit practice_started, practice_completed, practice_success,
practice_start_ms and (signed-in) practice_save_ms. Initial targets are
p95 start under 1s, p95 save under 1.5s, and failure rates below 1%.
Capture DB pool wait and queue age from provider/application telemetry.
Record Redis commands per exercise using the stage template in
`reports/baseline-template.md`; k6 does not have provider dashboard access.

The separate one-iteration retry check sends the same vocabulary attempt twice,
requires a deduplicated acknowledgement, then reads the learner's word progress
until exactly one expected XP and streak increment appears. It checks stability
for XP_OBSERVE_SECONDS (10 by default), with XP_WAIT_SECONDS (60) to see the
first award. This is a bounded end-to-end check, not a proof for all future
deliveries. Save results with `--summary-export=reports/<run-id>.json`.
