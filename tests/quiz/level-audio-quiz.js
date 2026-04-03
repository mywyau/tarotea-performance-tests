import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const LEVEL_SLUG = __ENV.LEVEL_SLUG || 'level-one';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

const startupBurstDuration = new Trend('startup_burst_duration');
const progressFetchDuration = new Trend('progress_fetch_duration');
const finalizeDuration = new Trend('finalize_duration');

function buildHeaders() {
  const token = tokens[(__VU - 1) % tokens.length];
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function createAttemptId() {
  return `k6-level-audio-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

function extractWordIdsFromLevelPayload(payload) {
  const categories = payload?.categories || {};
  const words = Object.values(categories).flat();

  if (!Array.isArray(words)) return [];

  return words
    .map((w) => w?.id)
    .filter(Boolean)
    .slice(0, 20);
}

export const options = {
  scenarios: {
    level_audio_quiz: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '1m', target: 75 },
        { duration: '1m', target: 75 },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1800', 'p(99)<3000'],
    checks: ['rate>0.99'],

    'http_req_duration{name:GET /api/vocab-quiz/:slug}': ['p(95)<1000'],
    'http_req_duration{name:GET /api/word-progress/weakestV2}': ['p(95)<1000'],
    'http_req_duration{name:GET /api/word-progress/v2}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/quiz/grind/finalize-v2}': ['p(95)<1200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();
  let selectedWordIds = [];

  group('startup burst', () => {
    const startedAt = Date.now();

    const responses = http.batch([
      [
        'GET',
        `${BASE_URL}/api/vocab-quiz/${LEVEL_SLUG}`,
        null,
        { headers, tags: { name: 'GET /api/vocab-quiz/:slug' } },
      ],
      [
        'GET',
        `${BASE_URL}/api/word-progress/weakestV2?level=${encodeURIComponent(LEVEL_SLUG)}`,
        null,
        { headers, tags: { name: 'GET /api/word-progress/weakestV2' } },
      ],
    ]);

    startupBurstDuration.add(Date.now() - startedAt);

    const quizRes = responses[0];
    const weakestRes = responses[1];

    check(quizRes, {
      'vocab quiz 200': (r) => r.status === 200,
    });

    check(weakestRes, {
      'weakestV2 200': (r) => r.status === 200,
    });

    if (quizRes.status !== 200) return;

    let quizJson;
    try {
      quizJson = quizRes.json();
    } catch (_) {
      return;
    }

    selectedWordIds = extractWordIdsFromLevelPayload(quizJson);

    check(selectedWordIds, {
      'selected word ids present': (ids) => ids.length > 0,
    });
  });

  if (selectedWordIds.length === 0) {
    sleep(randomBetween(0.1, 0.2));
    return;
  }

  group('fetch selected word progress', () => {
    const res = http.get(
      `${BASE_URL}/api/word-progress/v2?wordIds=${encodeURIComponent(selectedWordIds.join(','))}`,
      { headers, tags: { name: 'GET /api/word-progress/v2' } }
    );

    progressFetchDuration.add(res.timings.duration);

    check(res, {
      'word progress v2 200': (r) => r.status === 200,
    });
  });

  sleep(randomBetween(10, 20));

  group('finalize level audio quiz', () => {
    const payload = {
      attemptId: createAttemptId(),
      mode: 'grind-level-audio',
      answers: selectedWordIds.map((wordId, index) => ({
        wordId,
        correct: index % 2 === 0,
      })),
    };

    const res = http.post(
      `${BASE_URL}/api/quiz/grind/finalize-v2`,
      JSON.stringify(payload),
      { headers, tags: { name: 'POST /api/quiz/grind/finalize-v2' } }
    );

    finalizeDuration.add(res.timings.duration);

    check(res, {
      'finalize 200': (r) => r.status === 200,
    });
  });

  sleep(randomBetween(2, 5));
}