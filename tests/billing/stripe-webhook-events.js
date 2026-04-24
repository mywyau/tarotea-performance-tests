import { check, sleep } from 'k6';
import crypto from 'k6/crypto';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.APP_BASE_URL || 'https://www.tarotea.co.uk').replace(/\/$/, '');
const WEBHOOK_PATH = __ENV.STRIPE_WEBHOOK_PATH || '/api/stripe/webhook';
const WEBHOOK_URL = `${BASE_URL}${WEBHOOK_PATH}`;
const WEBHOOK_SECRET = __ENV.STRIPE_WEBHOOK_SECRET || '';

const EVENT_TYPES = (__ENV.STRIPE_EVENT_TYPES || 'checkout.session.completed,invoice.paid,customer.subscription.updated,payment_intent.payment_failed')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

const ACCEPTED_STATUSES = (__ENV.ACCEPTED_STATUSES || '200')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

const DUPLICATE_EVERY = Number(__ENV.DUPLICATE_EVERY || 0);

if (!EVENT_TYPES.length) {
  throw new Error('STRIPE_EVENT_TYPES must contain at least one event type');
}

if (!ACCEPTED_STATUSES.length) {
  throw new Error('ACCEPTED_STATUSES must contain at least one status code');
}

if (!WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET is required to generate a valid Stripe-Signature header');
}

const webhookDuration = new Trend('stripe_webhook_request_duration');
const webhookAccepted = new Counter('stripe_webhook_accepted');
const webhookDuplicate = new Counter('stripe_webhook_duplicate_response');

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildResourceObject(type, eventId) {
  const stripeSubscriptionId = __ENV.STRIPE_SUBSCRIPTION_ID || `sub_load_${eventId}`;
  const stripeCustomerId = __ENV.STRIPE_CUSTOMER_ID || `cus_load_${eventId}`;

  if (type.startsWith('checkout.session')) {
    return {
      id: `cs_test_${eventId}`,
      object: 'checkout.session',
      mode: 'subscription',
      customer: stripeCustomerId,
      subscription: stripeSubscriptionId,
      metadata: {
        userId: __ENV.USER_ID || `load_user_${__VU}`,
        plan: __ENV.DEFAULT_PLAN || 'monthly',
      },
    };
  }

  if (type.startsWith('invoice')) {
    return {
      id: `in_test_${eventId}`,
      object: 'invoice',
      customer: stripeCustomerId,
      subscription: stripeSubscriptionId,
      status: type === 'invoice.paid' ? 'paid' : 'open',
    };
  }

  if (type.startsWith('customer.subscription')) {
    return {
      id: stripeSubscriptionId,
      object: 'subscription',
      customer: stripeCustomerId,
      status: type === 'customer.subscription.deleted' ? 'canceled' : 'active',
      metadata: {
        userId: __ENV.USER_ID || `load_user_${__VU}`,
        plan: __ENV.DEFAULT_PLAN || 'monthly',
      },
    };
  }

  return {
    id: `pi_test_${eventId}`,
    object: 'payment_intent',
    customer: stripeCustomerId,
    metadata: {
      userId: __ENV.USER_ID || `load_user_${__VU}`,
      plan: __ENV.DEFAULT_PLAN || 'monthly',
    },
  };
}

function buildEventPayload(eventId) {
  const type = randomItem(EVENT_TYPES);
  const now = Math.floor(Date.now() / 1000);

  return {
    id: eventId,
    object: 'event',
    type,
    created: now,
    livemode: false,
    pending_webhooks: 1,
    data: {
      object: buildResourceObject(type, eventId),
    },
    request: {
      id: null,
      idempotency_key: `ik_load_${eventId}`,
    },
  };
}

function buildStripeSignature(rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  const signature = crypto.hmac('sha256', WEBHOOK_SECRET, signedPayload, 'hex');

  return `t=${timestamp},v1=${signature}`;
}

export const options = {
  scenarios: {
    stripe_webhook_ingestion: {
      executor: 'ramping-arrival-rate',
      startRate: 1,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 100,
      stages: [
        { duration: '20s', target: 5 },
        { duration: '40s', target: 30 },
        { duration: '40s', target: 30 },
        { duration: '20s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.98'],
    'http_req_duration{name:POST /api/stripe/webhook}': ['p(95)<1200'],
    stripe_webhook_request_duration: ['p(95)<1200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const shouldDuplicate = DUPLICATE_EVERY > 0 && __ITER > 0 && __ITER % DUPLICATE_EVERY === 0;
  const duplicateSlot = Math.floor(__ITER / Math.max(1, DUPLICATE_EVERY));
  const eventId = shouldDuplicate
    ? `evt_load_dup_${__VU}_${duplicateSlot}`
    : `evt_load_${__VU}_${__ITER}_${Date.now()}`;

  const body = JSON.stringify(buildEventPayload(eventId));
  const timestamp = Math.floor(Date.now() / 1000);
  headers['Stripe-Signature'] = buildStripeSignature(body, timestamp);

  const res = http.post(WEBHOOK_URL, body, {
    headers,
    tags: { name: 'POST /api/stripe/webhook' },
  });

  webhookDuration.add(res.timings.duration);

  const ok = check(res, {
    'webhook status accepted': (r) => ACCEPTED_STATUSES.includes(r.status),
    'webhook body exists': (r) => !!r.body,
  });

  if (ok) {
    webhookAccepted.add(1);

    let json;
    try {
      json = res.json();
    } catch (_) {
      sleep(randomBetween(0.1, 0.5));
      return;
    }

    if (json?.duplicate === true) {
      webhookDuplicate.add(1);
    }
  }

  sleep(randomBetween(0.1, 0.5));
}
