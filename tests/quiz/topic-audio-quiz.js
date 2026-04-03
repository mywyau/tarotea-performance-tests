import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const TOPIC_SLUG = __ENV.TOPIC_SLUG || 'survival-essentials';
const CDN_BASE = __ENV.CDN_BASE || BASE_URL;

// true = also fetch audio files like the page does
const FETCH_AUDIO = (__ENV.FETCH_AUDIO || 'true').toLowerCase() === 'true';

// mixed | correct | wrong | random
const ANSWER_MODE = (__ENV.ANSWER_MODE || 'mixed').toLowerCase();

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const loadDuration = new Trend('topic_audio_quiz_load_duration');
const finalizeDuration = new Trend('topic_audio_quiz_finalize_duration');
const audioDuration = new Trend('topic_audio_quiz_file_duration');

const quizzesLoaded = new Counter('topic_audio_quizzes_loaded');
const quizzesFinalized = new Counter('topic_audio_quizzes_finalized');
const audioFilesFetched = new Counter('topic_audio_files_fetched');

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
  return `k6-topic-audio-${__VU}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export const options = {
  scenarios: {
    topic_audio_quiz_page: {
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

    'http_req_duration{name:GET /api/topic/audio-quiz/:topicSlug}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/quiz/grind/finalize-v4}': ['p(95)<1200'],

    topic_audio_quiz_load_duration: ['p(95)<1200'],
    topic_audio_quiz_finalize_duration: ['p(95)<1200'],
    topic_audio_quiz_file_duration: ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let questions = [];
  let answers = [];
  let attemptId = null;

  group('load topic audio quiz', () => {
    const res = http.get(
      `${BASE_URL}/api/topic/audio-quiz/${encodeURIComponent(TOPIC_SLUG)}`,
      {
        headers,
        tags: { name: 'GET /api/topic/audio-quiz/:topicSlug' },
      }
    );

    loadDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic audio quiz load 200': (r) => r.status === 200,
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

    answers = questions
      .filter((q) => q?.wordId)
      .map((q, index) => ({
        wordId: q.wordId,
        correct: decideCorrect(index),
      }));

    check({ json, questions, answers }, {
      'topic present': (x) => !!x.json?.topic,
      'title present': (x) => !!x.json?.title,
      'questions returned': (x) => x.questions.length > 0,
      'answers built': (x) => x.answers.length > 0,
      'totalQuestions matches length': (x) =>
        Number(x.json?.totalQuestions ?? 0) === x.questions.length,
      'progressMap present': (x) =>
        !!x.json?.progressMap && typeof x.json.progressMap === 'object',
      'wordsById present': (x) =>
        !!x.json?.wordsById && typeof x.json.wordsById === 'object',
    });

    if (questions.length > 0) {
      check(questions[0], {
        'question type audio': (q) => q?.type === 'audio',
        'question has wordId': (q) => !!q?.wordId,
        'question has audioKey': (q) => !!q?.audioKey,
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
    const audioKey = q?.audioKey || null;

    if (FETCH_AUDIO && audioKey) {
      const audioRes = http.get(`${CDN_BASE}/audio/${audioKey}`, {
        headers: {
          Accept: 'audio/mpeg,*/*',
        },
        tags: { name: 'GET /audio/:audioKey' },
      });

      audioDuration.add(audioRes.timings.duration);
      audioFilesFetched.add(1);

      check(audioRes, {
        'topic audio file fetch 200/206': (r) => r.status === 200 || r.status === 206,
      });
    }

    sleep(randomBetween(2, 6));
  }

  attemptId = createAttemptId();

  group('finalize topic audio quiz', () => {
    const res = http.post(
      `${BASE_URL}/api/quiz/grind/finalize-v4`,
      JSON.stringify({
        attemptId,
        mode: 'grind-topic-audio',
        answers,
      }),
      {
        headers,
        tags: { name: 'POST /api/quiz/grind/finalize-v4' },
      }
    );

    finalizeDuration.add(res.timings.duration);

    const ok = check(res, {
      'topic audio finalize 200': (r) => r.status === 200,
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
      'finalize queued optional boolean': (body) =>
        body?.queued === undefined || typeof body.queued === 'boolean',
      'finalize deduped optional boolean': (body) =>
        body?.deduped === undefined || typeof body.deduped === 'boolean',
    });
  });

  sleep(randomBetween(5, 20));
}