import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const WORD_ID = __ENV.WORD_ID;
const DO_UNLOCK = (__ENV.DO_UNLOCK || 'false').toLowerCase() === 'true';

if (!WORD_ID) {
  throw new Error('WORD_ID env var is required, e.g. WORD_ID=abc123');
}

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const unlockSummaryDuration = new Trend('word_unlock_summary_duration');
const wordDetailDuration = new Trend('word_detail_duration');
const unlockPostDuration = new Trend('word_unlock_post_duration');

const unlockSummaryLoaded = new Counter('word_unlock_summary_loaded');
const wordDetailLoaded = new Counter('word_detail_loaded');
const unlockAttempts = new Counter('word_unlock_attempts');

function getToken() {
  const index = (__VU + __ITER) % tokens.length;
  return tokens[index];
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

export const options = {
  scenarios: {
    word_unlock_page: {
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
    http_req_failed: ['rate<0.02'],
    http_req_duration: ['p(95)<2000', 'p(99)<3500'],
    checks: ['rate>0.98'],

    'http_req_duration{name:GET /api/word-unlocks}': ['p(95)<1200'],
    'http_req_duration{name:GET /api/words/:wordId}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/word-unlocks}': ['p(95)<1500'],

    word_unlock_summary_duration: ['p(95)<1200'],
    word_detail_duration: ['p(95)<1200'],
    word_unlock_post_duration: ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  group('load unlock summary', () => {
    const res = http.get(
      `${BASE_URL}/api/word-unlocks?wordIds=${encodeURIComponent(WORD_ID)}`,
      {
        headers,
        tags: { name: 'GET /api/word-unlocks' },
      }
    );

    unlockSummaryDuration.add(res.timings.duration);

    const ok = check(res, {
      'word unlock summary 200': (r) => r.status === 200,
    });

    if (ok) {
      unlockSummaryLoaded.add(1);
    }
  });

  group('load word detail', () => {
    const res = http.get(
      `${BASE_URL}/api/words/${encodeURIComponent(WORD_ID)}`,
      {
        tags: { name: 'GET /api/words/:wordId' },
      }
    );

    wordDetailDuration.add(res.timings.duration);

    const ok = check(res, {
      'word detail 200': (r) => r.status === 200,
    });

    if (ok) {
      wordDetailLoaded.add(1);
    }
  });

  if (DO_UNLOCK) {
    group('unlock word', () => {
      const res = http.post(
        `${BASE_URL}/api/word-unlocks`,
        JSON.stringify({ wordId: WORD_ID }),
        {
          headers,
          tags: { name: 'POST /api/word-unlocks' },
        }
      );

      unlockPostDuration.add(res.timings.duration);

      const ok = check(res, {
        'unlock non-5xx': (r) => r.status < 500,
      });

      if (ok) {
        unlockAttempts.add(1);
      }
    });
  }

  sleep(randomBetween(1, 3));
}
