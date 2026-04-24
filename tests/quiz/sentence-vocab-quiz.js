import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const LEVEL_SLUG = __ENV.LEVEL_SLUG || 'level-three';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const startDuration = new Trend('sentence_start_duration');
const finalizeDuration = new Trend('sentence_finalize_duration');

function getToken() {
  const index = (__VU + __ITER) % tokens.length;
  return tokens[index];
}

function buildHeaders() {
  const token = getToken();

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

export const options = {
  scenarios: {
    sentence_audio_quiz: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1800', 'p(99)<3000'],
    checks: ['rate>0.99'],

    'http_req_duration{name:GET /api/sentences/v3/start-v2}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/sentences/v3/finalize}': ['p(95)<1200'],

    sentence_start_duration: ['p(95)<1200'],
    sentence_finalize_duration: ['p(95)<1200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let sessionKey = null;
  let answers = [];

  group('start sentence audio quiz', () => {
    const res = http.get(
      `${BASE_URL}/api/sentences/v3/start-v2?scope=level&slug=${encodeURIComponent(LEVEL_SLUG)}`,
      {
        headers,
        tags: { name: 'GET /api/sentences/v3/start-v2' },
      }
    );

    startDuration.add(res.timings.duration);

    check(res, {
      'sentence start 200': (r) => r.status === 200,
    });

    if (res.status !== 200) return;

    let json;
    try {
      json = res.json();
    } catch (_) {
      return;
    }

    sessionKey = json?.sessionKey;

    const questions = Array.isArray(json?.quiz?.questions)
      ? json.quiz.questions
      : [];

    answers = questions
      .filter((q) => q?.wordId && q?.sentenceId)
      .map((q, index) => ({
        wordId: q.wordId,
        sentenceId: q.sentenceId,
        correct: index % 2 === 0,
      }));

    check({ sessionKey, answers }, {
      'session key present': (x) => !!x.sessionKey,
      'sentence answers present': (x) => x.answers.length > 0,
    });
  });

  if (!sessionKey || answers.length === 0) {
    sleep(randomBetween(0.1, 0.2));
    return;
  }

  sleep(randomBetween(5, 10));

  group('finalize sentence audio quiz', () => {
    const res = http.post(
      `${BASE_URL}/api/sentences/v3/finalize`,
      JSON.stringify({
        sessionKey,
        answers,
      }),
      {
        headers,
        tags: { name: 'POST /api/sentences/v3/finalize' },
      }
    );

    finalizeDuration.add(res.timings.duration);

    check(res, {
      'sentence finalize 200': (r) => r.status === 200,
    });
  });

  sleep(randomBetween(1, 3));
}
