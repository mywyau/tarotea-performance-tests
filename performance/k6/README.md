# Manifest-driven k6 tests

These tests use `endpoints.json` as the source of truth and skip endpoints where `safeForLoadTest` is `false`.

Run commands from the repo root:

```sh
cd /Users/michaelyau/tarotea/tarotea-performance-tests
```

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
