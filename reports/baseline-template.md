# Production performance baseline

Status: planned
Run ID (UTC):
Owner:
Approver:

## Scope and approval

| Field | Value |
| --- | --- |
| Target base URL | `https://www.tarotea.co.uk` |
| Deployment commit | |
| Deployment timestamp | |
| Test window (UTC) | |
| Maximum approved VUs | |
| Expected near-term concurrency | |
| Expected near-term requests/second | |
| Provider-cost ceiling | |
| Authentication | anonymous / dedicated test users |
| Scripts approved | smoke / cache boundary / learner journey |

Do not begin until the target, deployment, maximum VUs, test window, and cost
ceiling are filled in and approved.

## Stop conditions

Stop the active stage and do not advance when any of the following occurs:

- unexpected HTTP failure rate reaches 2%;
- sustained p95 request latency exceeds 2,500 ms;
- unexpected 429 responses appear outside the documented endpoint limit;
- PostgreSQL connection usage reaches 80% of its hard limit or pool waits rise
  sharply;
- Upstash or QStash reports sustained errors or provider throttling;
- a customer-facing availability incident begins; or
- the approved traffic or cost ceiling is reached.

Record the actual stop reason and retain the lower-stage evidence.

## Environment snapshot

| Dependency | Plan/region/configuration | Capacity limit | Dashboard/source |
| --- | --- | --- | --- |
| Vercel | | | |
| PostgreSQL/pooler | | | |
| Upstash Redis | | | |
| QStash | | | |
| CDN/content origin | | | |

Database pool maximum per function instance:

Database hard connection limit:

Reserved database connections (admin/migrations/other services):

## Results

Use `n/a` when a signal is unavailable; do not silently leave it blank. Record
provider metrics over the exact stage window, not a broader daily aggregate.

| Stage | Requests | RPS | p50 | p95 | p99 | Failure % | 429 count | Outcome |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Smoke, 1 VU | | | | | | | | |
| Cache boundary, 1 VU | | | | | | | | |
| Learner, 1 VU | | | | | | | | |
| Learner, 5 VUs | | | | | | | | |
| Learner, 10 VUs | | | | | | | | |
| Learner, 25 VUs | | | | | | | | |

### Endpoint outliers

| Stage | Endpoint/group | Requests | p95 | p99 | Failure/429 evidence |
| --- | --- | ---: | ---: | ---: | --- |
| | | | | | |

### PostgreSQL

| Stage | Active peak | Idle peak | Waiting peak | Acquire p95 | Slow acquisitions | Query/acquire failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| | | | | | | |

### Upstash Redis

| Stage | Commands | Commands/journey | Latency p95 | Errors | Bandwidth | Rate-limit rejections |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| | | | | | | |

### QStash

| Stage | Published | Delivery p95 | Oldest message | Retries | Failures | Backlog peak |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| | | | | | | |

## Findings and decisions

First saturated or highest-risk dependency:

Evidence:

Safe operating point observed:

Recommended headroom:

Changes required before the next stage or release:

No-change decisions and rationale:

## Artifacts

- k6 summary exports:
- Vercel metric snapshot/link:
- PostgreSQL metric snapshot/link:
- Upstash metric snapshot/link:
- QStash metric snapshot/link:
- Redacted incident or anomaly notes:

## Sign-off

Result: pass / conditional pass / fail

Reviewed by:

Follow-up owner and due date:

## Practice capacity stages (staging)

Use a separate row for each profile, traffic mix and load level. Attach the k6
summary and provider snapshots for the same UTC interval. For a burst include
the later finish window and wait for the XP backlog to drain before taking
the final counters. Record unavailable metrics as n/a.

| Profile / guest or signed-in | UTC window / VUs | Starts/s peak | Saves/s peak | Started / completed | Dropped iterations / 429s | Start / save p95 ms | DB acquire p95 ms | Queue age p95 / oldest seconds | Redis commands delta / completed exercise | Outcome |
| --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

Record the observed concurrency, exercise duration, pre-existing background
traffic and token/account count. Divide the Redis counter change (subtract an
idle baseline if available) by completed exercises. Save the separate XP retry
check result and its time to visible XP.

Initial stage targets are p95 DB acquisition under 100 ms and p95 queue age
under 60 seconds. Record both API acknowledgements and worker processing,
including how long a burst takes to drain.
