import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const TOPIC_SLUG = __ENV.TOPIC_SLUG || 'survival-essentials';

// mixed | correct | wrong | random
const ANSWER_MODE = (__ENV.ANSWER_MODE || 'mixed').toLowerCase();

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const startDuration = new Trend('topic_sentence_audio_start_duration');
const finalizeDuration = new Trend('topic_sentence_audio_finalize_duration');

const quizzesStarted = new Counter('topic_sentence_audio_quizzes_started');
const quizzesFinalized = new Counter('topic_sentence_audio_quizzes_finalized');

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

function decideCorrect(index) {
  switch (ANSWER_MODE) {
    case 'correct':
      return true;
    case 'wrong':
      return false;
    case 'random':
      return Math.random() >= 0.5;
    case 'mixed':
    default:
      return index % 2 === 0;
  }
}

export const options = {
  scenarios: {
    topic_sentence_audio_quiz_page: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '60s', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1800', 'p(99)<3000'],
    checks: ['rate>0.99'],

    'http_req_duration{name:GET /api/sentences/topics/v2/start}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/sentences/topics/v2/finalize}': ['p(95)<1200'],

    topic_sentence_audio_start_duration: ['p(95)<1200'],
    topic_sentence_audio_finalize_duration: ['p(95)<1200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let sessionKey = null;
  let questions = [];
  let answers = [];

  group('start topic sentence audio quiz', () => {
    const res = http.get(
      `${BASE_URL}/api/sentences/topics/v2/start?scope=topic&slug=${encodeURIComponent(TOPIC_SLUG)}`,
      {
        headers,
        tags: { name: 'GET /api/sentences/topics/v2/start' },
      }
    );

    startDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic sentence audio start 200': (r) => r.status === 200,
    });

    if (!ok) return;

    quizzesStarted.add(1);

    let json;
    try {
      json = res.json();
    } catch (_) {
      return;
    }

    sessionKey = json?.sessionKey;
    questions = Array.isArray(json?.quiz?.questions) ? json.quiz.questions : [];

    answers = questions
      .filter((q) => q?.wordId && q?.sentenceId)
      .map((q, index) => ({
        wordId: q.wordId,
        sentenceId: q.sentenceId,
        correct: decideCorrect(index),
      }));

    check({ sessionKey, questions, answers, json }, {
      'session key present': (x) => !!x.sessionKey,
      'questions returned': (x) => x.questions.length > 0,
      'answers built': (x) => x.answers.length > 0,
      'quiz mode present': (x) => !!x.json?.quiz?.mode,
      'quiz topic present': (x) => !!x.json?.quiz?.topic,
      'totalQuestions matches length': (x) =>
        Number(x.json?.quiz?.totalQuestions ?? 0) === x.questions.length,
      'progress present': (x) => !!x.json?.progress && typeof x.json.progress === 'object',
    });

    if (questions.length > 0) {
      check(questions[0], {
        'question has sentenceId': (q) => !!q?.sentenceId,
        'question has wordId': (q) => !!q?.wordId,
        'question has prompt': (q) => !!q?.prompt,
        'question has sourceWord': (q) => !!q?.sourceWord,
        'question has sourceWordJyutping': (q) => !!q?.sourceWordJyutping,
        'question has options': (q) => Array.isArray(q?.options) && q.options.length >= 2,
        'question has valid correctIndex': (q) =>
          Number.isInteger(q?.correctIndex) &&
          q.correctIndex >= 0 &&
          q.correctIndex < (Array.isArray(q?.options) ? q.options.length : 0),
      });
    }
  });

  if (!sessionKey || answers.length === 0 || questions.length === 0) {
    sleep(randomBetween(1, 4));
    return;
  }

  for (let i = 0; i < questions.length; i++) {
    sleep(randomBetween(2, 6));
  }

  group('finalize topic sentence audio quiz', () => {
    const res = http.post(
      `${BASE_URL}/api/sentences/topics/v2/finalize`,
      JSON.stringify({
        sessionKey,
        answers,
      }),
      {
        headers,
        tags: { name: 'POST /api/sentences/topics/v2/finalize' },
      }
    );

    finalizeDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic sentence audio finalize 200': (r) => r.status === 200,
    });

    if (ok) {
      quizzesFinalized.add(1);
    }

    let json;
    try {
      json = res.json();
    } catch (_) {
      return;
    }

    check(json, {
      'queued flag optional boolean': (body) =>
        body?.queued === undefined || typeof body.queued === 'boolean',
      'deduped flag optional boolean': (body) =>
        body?.deduped === undefined || typeof body.deduped === 'boolean',
      'quiz object optional': (body) =>
        body?.quiz === undefined || typeof body.quiz === 'object',
    });
  });

  sleep(randomBetween(5, 20));
}