import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const TOPIC_SLUG = __ENV.TOPIC_SLUG || 'survival-essentials';

const LEVEL_SLUGS = (__ENV.LEVEL_SLUGS || 'hsk1').split(',');

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

const startupDuration = new Trend('quiz_startup_duration');
const finalizeDuration = new Trend('quiz_finalize_duration');
const sentenceStartupDuration = new Trend('sentence_startup_duration');
const sentenceFinalizeDuration = new Trend('sentence_finalize_duration');

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildHeaders() {
  const token = tokens[(__VU - 1) % tokens.length];
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function createAttemptId(prefix = 'quiz') {
  return `${prefix}-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

export const options = {
  scenarios: {
    level_word_quiz: {
      executor: 'ramping-vus',
      exec: 'runLevelWordQuiz',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '1m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
    level_audio_quiz: {
      executor: 'ramping-vus',
      exec: 'runLevelAudioQuiz',
      startTime: '10s',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 15 },
        { duration: '1m', target: 30 },
        { duration: '1m', target: 30 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
    sentence_audio_quiz: {
      executor: 'ramping-vus',
      exec: 'runSentenceAudioQuiz',
      startTime: '20s',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 10 },
        { duration: '1m', target: 20 },
        { duration: '1m', target: 20 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<2000', 'p(99)<3500'],

    'http_req_duration{name:GET /api/vocab-quiz/:slug}': ['p(95)<1200'],
    'http_req_duration{name:GET /api/word-progress/weakestV2}': ['p(95)<1000'],
    'http_req_duration{name:GET /api/word-progress/v2}': ['p(95)<1000'],
    'http_req_duration{name:POST /api/quiz/grind/finalize-v2}': ['p(95)<1200'],

    'http_req_duration{name:GET /api/sentences/v2/start}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/sentences/v2/finalize}': ['p(95)<1200'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

function loadLevelQuizStartup(headers, slug) {
  const started = Date.now();

  const responses = http.batch([
    ['GET', `${BASE_URL}/api/vocab-quiz/${slug}`, null, { headers, tags: { name: 'GET /api/vocab-quiz/:slug' } }],
    ['GET', `${BASE_URL}/api/word-progress/weakestV2?level=${encodeURIComponent(slug)}`, null, { headers, tags: { name: 'GET /api/word-progress/weakestV2' } }],
  ]);

  startupDuration.add(Date.now() - started);

  const quizRes = responses[0];
  const weakestRes = responses[1];

  check(quizRes, {
    'vocab quiz 200': (r) => r.status === 200,
  });

  check(weakestRes, {
    'weakestV2 200': (r) => r.status === 200,
  });

  if (quizRes.status !== 200) return null;

  let quizJson;
  try {
    quizJson = quizRes.json();
  } catch (_) {
    return null;
  }

  const categories = quizJson?.categories || {};
  const words = Object.values(categories).flat();
  if (!Array.isArray(words) || words.length === 0) return null;

  const wordIds = words
    .map((w) => w?.id)
    .filter(Boolean)
    .slice(0, 20);

  if (!wordIds.length) return null;

  const progressRes = http.get(
    `${BASE_URL}/api/word-progress/v2?wordIds=${encodeURIComponent(wordIds.join(','))}`,
    { headers, tags: { name: 'GET /api/word-progress/v2' } }
  );

  check(progressRes, {
    'word progress v2 200': (r) => r.status === 200,
  });

  return wordIds;
}

function finalizeLevelQuiz(headers, mode, wordIds) {
  const payload = {
    attemptId: createAttemptId(mode),
    mode,
    answers: wordIds.map((wordId, index) => ({
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
    'level finalize 200': (r) => r.status === 200,
  });
}

export function runLevelWordQuiz() {
  const headers = buildHeaders();
  const slug = randomItem(LEVEL_SLUGS);

  group('level word quiz', () => {
    const wordIds = loadLevelQuizStartup(headers, slug);
    if (!wordIds) {
      sleep(randomBetween(2, 6));
      return;
    }

    sleep(randomBetween(20, 60));
    finalizeLevelQuiz(headers, 'grind-level', wordIds);
    sleep(randomBetween(5, 15));
  });
}

export function runLevelAudioQuiz() {
  const headers = buildHeaders();
  const slug = randomItem(LEVEL_SLUGS);

  group('level audio quiz', () => {
    const wordIds = loadLevelQuizStartup(headers, slug);
    if (!wordIds) {
      sleep(randomBetween(2, 6));
      return;
    }

    sleep(randomBetween(20, 60));
    finalizeLevelQuiz(headers, 'grind-level-audio', wordIds);
    sleep(randomBetween(5, 15));
  });
}

export function runSentenceAudioQuiz() {
  const headers = buildHeaders();
  const slug = randomItem(LEVEL_SLUGS);

  group('sentence audio quiz', () => {
    const started = Date.now();

    const startRes = http.get(
      `${BASE_URL}/api/sentences/v2/start?scope=level&slug=${encodeURIComponent(slug)}`,
      { headers, tags: { name: 'GET /api/sentences/v2/start' } }
    );

    sentenceStartupDuration.add(Date.now() - started);

    check(startRes, {
      'sentence start 200': (r) => r.status === 200,
    });

    if (startRes.status !== 200) {
      sleep(randomBetween(2, 6));
      return;
    }

    let startJson;
    try {
      startJson = startRes.json();
    } catch (_) {
      sleep(randomBetween(2, 6));
      return;
    }

    const sessionKey = startJson?.sessionKey;
    const questions = Array.isArray(startJson?.quiz?.questions) ? startJson.quiz.questions : [];

    if (!sessionKey || !questions.length) {
      sleep(randomBetween(2, 6));
      return;
    }

    const answers = questions.map((q, index) => ({
      wordId: q.wordId,
      sentenceId: q.sentenceId,
      correct: index % 2 === 0,
    }));

    sleep(randomBetween(30, 90));

    const finalizeRes = http.post(
      `${BASE_URL}/api/sentences/v2/finalize`,
      JSON.stringify({ sessionKey, answers }),
      { headers, tags: { name: 'POST /api/sentences/v2/finalize' } }
    );

    sentenceFinalizeDuration.add(finalizeRes.timings.duration);

    check(finalizeRes, {
      'sentence finalize 200': (r) => r.status === 200,
    });

    sleep(randomBetween(5, 15));
  });
}