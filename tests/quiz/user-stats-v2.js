import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const statsRequestDuration = new Trend('user_stats_request_duration');
const statsLoaded = new Counter('user_stats_loaded');

function getToken() {
  const index = (__VU + __ITER) % tokens.length;
  return tokens[index];
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

function asFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num);
}

export const options = {
  scenarios: {
    user_stats_page: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 20 },
        { duration: '20s', target: 40 },
        { duration: '20s', target: 60 },
        { duration: '40s', target: 60 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1200', 'p(99)<2000'],
    checks: ['rate>0.99'],

    'http_req_duration{name:GET /api/user/stats/v2}': ['p(95)<1000'],
    user_stats_request_duration: ['p(95)<1000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };

  const res = http.get(`${BASE_URL}/api/user/stats/v2`, {
    headers,
    tags: { name: 'GET /api/user/stats/v2' },
  });

  statsRequestDuration.add(res.timings.duration);

  const ok = check(res, {
    'user stats 200': (r) => r.status === 200,
    'user stats has body': (r) => !!r.body,
  });

  if (ok) {
    let json;
    try {
      json = res.json();
    } catch (_) {
      sleep(randomBetween(1, 2));
      return;
    }

    const shapeOk = check(json, {
      'total_xp numeric': (body) => asFiniteNumber(body?.total_xp),
      'xp_this_week numeric': (body) => asFiniteNumber(body?.xp_this_week),
      'words_unlocked numeric': (body) => asFiniteNumber(body?.words_unlocked),
      'words_maxed numeric': (body) => asFiniteNumber(body?.words_maxed),
      'words_seen numeric': (body) => asFiniteNumber(body?.words_seen),
      'total_correct numeric': (body) => asFiniteNumber(body?.total_correct),
      'total_wrong numeric': (body) => asFiniteNumber(body?.total_wrong),
    });

    if (shapeOk) {
      statsLoaded.add(1);
    }
  }

  sleep(randomBetween(1, 3));
}
