import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://www.tarotea.dev';
const LEVEL_SLUG = __ENV.LEVEL_SLUG || 'level-one';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('./tokens.json'));
});

const quizLoadDuration = new Trend('quiz_load_duration');
const quizFinalizeDuration = new Trend('quiz_finalize_duration');

function thinkTimeSeconds(min, max) {
  return Math.random() * (max - min) + min;
}

export const options = {
  scenarios: {
    quiz_journey: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '15s', target: 20 },
        { duration: '30s', target: 40 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 40 },
        { duration: '15s', target: 20 },
      ],
      gracefulRampDown: '15s',
    },
  },

  thresholds: {
    // Global built-in HTTP request latency across all requests
    http_req_duration: [
      'p(95)<1500',
      'p(99)<3000',
    ],

    // Global error rate
    http_req_failed: [
      'rate<0.01', // less than 1% failed requests
    ],

    // Custom checks pass rate
    checks: [
      'rate>0.99', // more than 99% of checks should pass
    ],

    // Custom trend metrics
    quiz_load_duration: [
      'p(95)<800',
      'p(99)<1000',
    ],
    quiz_finalize_duration: [
      'p(95)<1000',
      'p(99)<1500',
    ],
  },

  // So p95/p99 show clearly in end-of-test summary output
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

function buildHeaders() {
  const token = tokens[(__VU - 1) % tokens.length];

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function flattenQuizItems(quizJson) {
  const categories = quizJson?.categories;
  if (!categories || typeof categories !== 'object') return [];

  return Object.values(categories)
    .filter(Array.isArray)
    .flat();
}

function getWordId(item) {
  return item?.id || item?.wordId || item?.sourceWordId || null;
}

function levelQuizRequest(headers) {
  return http.get(
    `${BASE_URL}/api/vocab-quiz/${LEVEL_SLUG}`,
    { headers }
  );
}

function finalizeLevelQuiz(headers, payload) {
  return http.post(
    `${BASE_URL}/api/quiz/grind/finalize`,
    JSON.stringify(payload),
    { headers }
  );
}

export default function () {
  const headers = buildHeaders();
  let selectedWordIds = [];

  group('load quiz', () => {
    const quizRes = levelQuizRequest(headers);

    quizLoadDuration.add(quizRes.timings.duration);

    check(quizRes, {
      'quiz load status 200': (r) => r.status === 200,
    });

    if (quizRes.status !== 200) return;

    let quizJson;
    try {
      quizJson = quizRes.json();
    } catch (_) {
      return;
    }

    const items = flattenQuizItems(quizJson);

    selectedWordIds = items
      .map(getWordId)
      .filter(Boolean)
      .slice(0, 5);
  });

  if (selectedWordIds.length === 0) {
    sleep(1);
    return;
  }

  // pretend thinking/quiz completion
  sleep(thinkTimeSeconds(10, 20));

  group('finalize quiz', () => {
    const payload = {
      mode: 'grind-level',
      answers: selectedWordIds.map((wordId, index) => ({
        wordId,
        correct: index % 2 === 0,
      })),
    };

    const finalizeRes = finalizeLevelQuiz(headers, payload);

    quizFinalizeDuration.add(finalizeRes.timings.duration);

    check(finalizeRes, {
      'finalize status 200': (r) => r.status === 200,
    });
  });

  sleep(1);
}