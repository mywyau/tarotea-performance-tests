import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const TOPIC_SLUG = __ENV.TOPIC_SLUG || 'survival-essentials';
const CDN_BASE = (__ENV.CDN_BASE || BASE_URL).replace(/\/$/, '');

// true = fetch success jingle on the completion screen
const FETCH_SUCCESS_JINGLE = (__ENV.FETCH_SUCCESS_JINGLE || 'true').toLowerCase() === 'true';
const SUCCESS_JINGLE_PATH = (__ENV.SUCCESS_JINGLE_PATH || '/audio/sfx/quiz-success.mp3').replace(/^\//, '');

// true = also fetch /audio/{wordId}.mp3 after each answer like the page does
const FETCH_WORD_AUDIO = (__ENV.FETCH_WORD_AUDIO || 'true').toLowerCase() === 'true';

// mixed | correct | wrong | random
const ANSWER_MODE = (__ENV.ANSWER_MODE || 'mixed').toLowerCase();

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const loadDuration = new Trend('topic_word_quiz_load_duration');
const finalizeDuration = new Trend('topic_word_quiz_finalize_duration');
const audioDuration = new Trend('topic_word_quiz_audio_duration');
const successJingleDuration = new Trend('topic_word_quiz_success_jingle_duration');

const quizzesLoaded = new Counter('topic_word_quizzes_loaded');
const quizzesFinalized = new Counter('topic_word_quizzes_finalized');
const wordAudioFetched = new Counter('topic_word_audio_files_fetched');
const successJinglesFetched = new Counter('topic_word_success_jingles_fetched');

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

function createAttemptId() {
  return `k6-topic-quiz-${__VU}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export const options = {
  scenarios: {
    topic_word_quiz_page: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 25 },
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

    'http_req_duration{name:GET /api/topic/quiz/:topicSlug}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/quiz/grind/finalize-v5}': ['p(95)<1200'],
    'http_req_duration{name:GET /audio/sfx/quiz-success.mp3}': ['p(95)<1500'],

    topic_word_quiz_load_duration: ['p(95)<1200'],
    topic_word_quiz_finalize_duration: ['p(95)<1200'],
    topic_word_quiz_audio_duration: ['p(95)<1500'],
    topic_word_quiz_success_jingle_duration: ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let questions = [];
  let wordsById = {};
  let answers = [];
  let attemptId = null;

  group('load topic word quiz', () => {
    const res = http.get(
      `${BASE_URL}/api/topic/quiz/${encodeURIComponent(TOPIC_SLUG)}`,
      {
        headers,
        tags: { name: 'GET /api/topic/quiz/:topicSlug' },
      }
    );

    loadDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic word quiz load 200': (r) => r.status === 200,
    });

    if (!ok) return;

    quizzesLoaded.add(1);

    let json;
    try {
      json = res.json();
    } catch (_) {
      return;
    }

    questions = Array.isArray(json?.questions) ? json.questions : [];
    wordsById = json?.wordsById && typeof json.wordsById === 'object' ? json.wordsById : {};

    answers = questions
      .filter((q) => q?.wordId)
      .map((q, index) => ({
        wordId: q.wordId,
        correct: decideCorrect(index),
      }));

    check({ json, questions, answers, wordsById }, {
      'topic present': (x) => !!x.json?.topic,
      'title present': (x) => !!x.json?.title,
      'questions returned': (x) => x.questions.length > 0,
      'answers built': (x) => x.answers.length > 0,
      'totalQuestions matches length': (x) =>
        Number(x.json?.totalQuestions ?? 0) === x.questions.length,
      'progressMap present': (x) =>
        !!x.json?.progressMap && typeof x.json.progressMap === 'object',
      'wordsById present': (x) =>
        !!x.wordsById && typeof x.wordsById === 'object',
    });

    if (questions.length > 0) {
      check(questions[0], {
        'question has wordId': (q) => !!q?.wordId,
        'question has prompt': (q) => !!q?.prompt,
        'question has options': (q) => Array.isArray(q?.options) && q.options.length >= 2,
        'question has valid correctIndex': (q) =>
          Number.isInteger(q?.correctIndex) &&
          q.correctIndex >= 0 &&
          q.correctIndex < (Array.isArray(q?.options) ? q.options.length : 0),
      });
    }
  });

  if (!questions.length || !answers.length) {
    sleep(randomBetween(1, 4));
    return;
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const wordId = q?.wordId || null;

    // User reads question, chooses answer
    sleep(randomBetween(0.1, 0.2));

    // Small delay before next
    sleep(randomBetween(0.1, 0.2));
  }

  attemptId = createAttemptId();

  group('finalize topic word quiz', () => {
    const res = http.post(
      `${BASE_URL}/api/quiz/grind/finalize-v5`,
      JSON.stringify({
        attemptId,
        mode: 'grind-topic',
        answers,
      }),
      {
        headers,
        tags: { name: 'POST /api/quiz/grind/finalize-v5' },
      }
    );

    finalizeDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic word finalize 200': (r) => r.status === 200,
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
      'finalize returns quiz object': (body) => !!body?.quiz,
      'finalize returns xpEarned': (body) => typeof body?.quiz?.xpEarned === 'number',
      'finalize returns attemptId': (body) => typeof body?.attemptId === 'string',
      'queued optional boolean': (body) =>
        body?.queued === undefined || typeof body.queued === 'boolean',
      'deduped optional boolean': (body) =>
        body?.deduped === undefined || typeof body.deduped === 'boolean',
    });

    if (!ok || !FETCH_SUCCESS_JINGLE) {
      return;
    }

    const jingleRes = http.get(`${CDN_BASE}/${SUCCESS_JINGLE_PATH}`, {
      headers: { Accept: 'audio/mpeg,*/*' },
      tags: { name: 'GET /audio/sfx/quiz-success.mp3' },
    });

    successJingleDuration.add(jingleRes.timings.duration);

    const jingleOk = check(jingleRes, {
      'success jingle fetch 200/206': (r) => r.status === 200 || r.status === 206,
    });

    if (jingleOk) {
      successJinglesFetched.add(1);
    }
  });

  sleep(randomBetween(1, 2));
}