# Manifest-driven k6 tests

These tests use `endpoints.json` as the source of truth and skip endpoints where `safeForLoadTest` is `false`.

## Auth tokens

The tests can authenticate in four ways:

- `AUTH_TOKEN`: one bearer token for every virtual user.
- `AUTH_TOKENS`: comma-separated bearer tokens, rotated by VU and iteration.
- `AUTH_TOKENS_FILE`: path to a JSON array of tokens. By default the tests look for the existing generator output at `auth/tokens.json`.
- `SESSION_COOKIE`: browser session cookie, used when bearer tokens are not appropriate.

Generate the default token file with the existing script:

```sh
USER_COUNT=50 APP_BASE_URL=https://www.tarotea.co.uk node auth/generate-test-tokens.mjs
```

## Smoke safe GET endpoints

Runs only safe `GET` endpoints from the manifest. Authenticated endpoints are skipped unless `AUTH_TOKEN` or `SESSION_COOKIE` is provided.
If `auth/tokens.json` exists, authenticated endpoints use those generated Auth0 tokens automatically.
`WORD_ID` and `SENTENCE_ID` are optional; when omitted, the script discovers defaults from `TOPIC_SLUG`.
`TOPIC_SENTENCE_SLUG` defaults to `${TOPIC_SLUG}-sentences` for `/api/topic/sentences/:id`.

```sh
k6 run performance/k6/smoke-safe-get.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials
```

## Learner journey

Runs a realistic read-only learner flow: health and public discovery, content browsing, safe quiz starts, dashboard reads, and authenticated practice starts. It does not call finalize, worker, billing, upload, audio generation, destructive, or other unsafe endpoints.
`WORD_ID` and `SENTENCE_ID` are optional overrides; when omitted, the script discovers defaults from the configured topic.
`TOPIC_SENTENCE_SLUG` defaults to `${TOPIC_SLUG}-sentences` for the legacy topic sentence-set endpoint.

```sh
k6 run performance/k6/learner-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1
```

`LEVEL` can be numeric (`1`, `8`) or you can pass `LEVEL_SLUG` directly (`level-one`, `level-eight`). Level sentence endpoints use the slug form and load CDN files such as `level-eight-sentences.json`.

Use `SESSION_COOKIE` instead of `AUTH_TOKEN` when testing browser-session authenticated paths.

## Diagnosing non-2xx/3xx responses

Both scripts emit endpoint/status metrics:

- `endpoint_status_count`: count of responses tagged by endpoint, category, method, path, and status.
- `endpoint_unexpected_status_rate`: rate of responses with status `>=400`, tagged the same way.

To print the first unexpected statuses during a run:

```sh
k6 run performance/k6/learner-journey.js \
  -e BASE_URL=https://www.tarotea.co.uk \
  -e TOPIC_SLUG=survival-essentials \
  -e LOG_UNEXPECTED_STATUSES=true
```

Use `UNEXPECTED_STATUS_LOG_LIMIT=100` to print more lines.
