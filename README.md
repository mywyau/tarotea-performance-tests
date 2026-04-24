# tarotea-performance-tests

###
k6 Grafana performance tests for tarotea

###
Make sure xp_quiz_events are clear


###
k6 cloud run level-word-quiz.js


k6 cloud run ./tests/quiz/sentence-vocab-quiz.js
k6 cloud run ./tests/quiz/sentence-audio-quiz.js
k6 cloud run ./tests/dojo/level-chinese.js

### Stripe and billing performance tests

Local run examples:

k6 run ./tests/billing/stripe-create-checkout-session.js \
  -e APP_BASE_URL=https://www.tarotea.co.uk \
  -e CHECKOUT_PATH=/api/stripe/checkout \
  -e REQUIRE_AUTH=true \
  -e BILLING_DISTRIBUTION=monthly,yearly,yearly

k6 run ./tests/billing/stripe-webhook-events.js \
  -e APP_BASE_URL=https://www.tarotea.co.uk \
  -e STRIPE_WEBHOOK_PATH=/api/stripe/webhook \
  -e STRIPE_WEBHOOK_SECRET=whsec_xxx \
  -e STRIPE_EVENT_TYPES=checkout.session.completed,invoice.paid,customer.subscription.updated

Useful env vars:
- `REQUIRE_AUTH=true|false` for checkout creation tests.
- `BILLING_DISTRIBUTION=monthly,yearly` to control checkout plan mix.
- `STRIPE_WEBHOOK_SECRET` to generate a valid `Stripe-Signature` header for webhook verification.
- `STRIPE_EVENT_TYPES` comma-separated list of event types for webhook ingestion tests.
- `ACCEPTED_STATUSES` comma-separated list of accepted webhook response statuses.
- `DUPLICATE_EVERY` set to `N` to periodically resend the same Stripe event id (dedupe test).
- `STRIPE_SUBSCRIPTION_ID`, `STRIPE_CUSTOMER_ID`, `USER_ID`, `DEFAULT_PLAN` to shape payload metadata.
