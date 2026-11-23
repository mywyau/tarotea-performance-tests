# Performance reports

Keep one Markdown report per controlled production baseline and store raw k6
summary exports beside it. Use names in UTC so results sort chronologically:

```text
reports/2026-11-18T2100Z-production-baseline.md
reports/2026-11-18T2100Z-smoke.json
reports/2026-11-18T2100Z-learner-1vu.json
```

Copy `baseline-template.md` for each run. Never store bearer tokens, session
cookies, database URLs, raw user identifiers, or provider API keys here.

The standard post-deploy command is `scripts/post-deploy-smoke.sh`; its JSON
summaries should be linked from the deployment annotation or dated baseline
report after secrets and unexpected response bodies have been checked.

## Production safety

- Obtain explicit approval for the target, time window, maximum VUs, and cost
  ceiling before creating production traffic.
- Use only read-only scripts unless dedicated test users and mutation approval
  have been recorded.
- Start with the smoke and cache-boundary checks at one VU.
- Run learner stages sequentially at 1, 5, 10, then 25 VUs. Stop rather than
  advancing when any stop condition in the report is reached.
- Watch Vercel, PostgreSQL, Upstash, and QStash during every stage. A k6 result
  alone cannot identify dependency saturation.
- Redact exported artifacts before committing them.

## Repeatable commands

Set a UTC run identifier without putting credentials in shell history:

```sh
RUN_ID=2026-11-18T2100Z
BASE_URL=https://www.tarotea.co.uk
```

Run the read-only gates:

```sh
k6 run performance/k6/smoke-safe-get.js \
  -e BASE_URL="$BASE_URL" \
  -e TOPIC_SLUG=survival-essentials \
  --summary-export="reports/${RUN_ID}-smoke.json"
```

```sh
k6 run performance/k6/cache-boundary-check.js \
  -e BASE_URL="$BASE_URL" \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL_SLUG=level-one \
  --summary-export="reports/${RUN_ID}-cache-boundary.json"
```

Run each learner stage independently so a bad stage does not automatically
advance to higher traffic:

```sh
k6 run performance/k6/learner-journey.js \
  -e BASE_URL="$BASE_URL" \
  -e TOPIC_SLUG=survival-essentials \
  -e LEVEL=1 \
  -e TARGET_VUS=1 \
  -e RAMP_UP=30s \
  -e STEADY_STATE=2m \
  -e RAMP_DOWN=30s \
  --summary-export="reports/${RUN_ID}-learner-1vu.json"
```

Repeat the learner command with `TARGET_VUS` and the output filename changed
to `5`, `10`, and `25`, only after reviewing the preceding stage.

Authentication is optional for the anonymous baseline. For an authenticated
baseline, use the token mechanisms documented in `performance/k6/README.md`;
do not place token values in the report or command transcript.
