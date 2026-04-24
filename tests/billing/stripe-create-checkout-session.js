import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.APP_BASE_URL || 'https://www.tarotea.co.uk').replace(/\/$/, '');
const CHECKOUT_PATH = __ENV.CHECKOUT_PATH || '/api/stripe/checkout';
const CHECKOUT_URL = `${BASE_URL}${CHECKOUT_PATH}`;
const REQUIRE_AUTH = (__ENV.REQUIRE_AUTH || 'true').toLowerCase() === 'true';
const BILLING_DISTRIBUTION = (__ENV.BILLING_DISTRIBUTION || 'monthly,yearly,yearly')
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item === 'monthly' || item === 'yearly');

const tokens = new SharedArray('tokens', function () {
  if (!REQUIRE_AUTH) return [];
  return JSON.parse(open('../../auth/tokens.json'));
});

if (REQUIRE_AUTH && !tokens.length) {
  throw new Error('tokens.json is empty while REQUIRE_AUTH=true');
}

if (!BILLING_DISTRIBUTION.length) {
  throw new Error('BILLING_DISTRIBUTION must include monthly and/or yearly values');
}

const requestDuration = new Trend('stripe_checkout_session_request_duration');
const sessionCreated = new Counter('stripe_checkout_session_created');

function getToken() {
  const index = (__VU + __ITER) % tokens.length;
  return tokens[index];
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildRequestBody() {
  return {
    billing: randomItem(BILLING_DISTRIBUTION),
  };
}

export const options = {
  scenarios: {
    create_checkout_session: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 5 },
        { duration: '30s', target: 20 },
        { duration: '30s', target: 20 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    checks: ['rate>0.98'],
    'http_req_duration{name:POST /api/stripe/checkout}': ['p(95)<1500'],
    stripe_checkout_session_request_duration: ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (REQUIRE_AUTH) {
    headers.Authorization = `Bearer ${getToken()}`;
  }

  const body = JSON.stringify(buildRequestBody());
  const res = http.post(CHECKOUT_URL, body, {
    headers,
    tags: { name: 'POST /api/stripe/checkout' },
  });

  requestDuration.add(res.timings.duration);

  const ok = check(res, {
    'create checkout session status 200': (r) => r.status === 200,
    'create checkout session has body': (r) => !!r.body,
  });

  if (ok) {
    let json;
    try {
      json = res.json();
    } catch (_) {
      sleep(randomBetween(0.5, 1.5));
      return;
    }

    const shapeOk = check(json, {
      'response has checkout url': (payload) => typeof payload?.url === 'string' && payload.url.length > 0,
    });

    if (shapeOk) {
      sessionCreated.add(1);
    }
  }

  sleep(randomBetween(0.5, 2));
}
