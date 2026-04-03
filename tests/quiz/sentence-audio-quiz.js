import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const LEVEL_SLUG = __ENV.LEVEL_SLUG || 'level-one';
const CDN_BASE = __ENV.CDN_BASE || 'https://www.tarotea.co.uk';

// Whether to also fetch the audio mp3 files like the page does.
// Set FETCH_AUDIO=false if you only want backend API load.
const FETCH_AUDIO = (__ENV.FETCH_AUDIO || 'true').toLowerCase() === 'true';

// How the simulated user answers:
// "mixed" = alternating correct/incorrect
// "correct" = all correct
// "wrong" = all wrong
// "random" = random true/false
const ANSWER_MODE = (__ENV.ANSWER_MODE || 'mixed').toLowerCase();

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const startDuration = new Trend('sentence_audio_start_duration');
const finalizeDuration = new Trend('sentence_audio_finalize_duration');
const audioDuration = new Trend('sentence_audio_file_duration');

const quizzesStarted = new Counter('sentence_audio_quizzes_started');
const quizzesFinalized = new Counter('sentence_audio_quizzes_finalized');
const audioFilesFetched = new Counter('sentence_audio_files_fetched');

function getToken() {
  // Rotates across both VUs and iterations so the same VU does not keep reusing only one token.
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
    sentence_audio_quiz_page: {
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
    http_req_duration: ['p(95)<2000', 'p(99)<3500'],
    checks: ['rate>0.99'],

    'http_req_duration{name:GET /api/sentences/v2/start}': ['p(95)<1200'],
    'http_req_duration{name:POST /api/sentences/v2/finalize}': ['p(95)<1500'],

    sentence_audio_start_duration: ['p(95)<1200'],
    sentence_audio_finalize_duration: ['p(95)<1500'],

    // Only meaningful if FETCH_AUDIO=true
    sentence_audio_file_duration: ['p(95)<1500'],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let sessionKey = null;
  let answers = [];
  let questions = [];

  group('start sentence audio quiz', () => {
    const res = http.get(
      `${BASE_URL}/api/sentences/v2/start?scope=level&slug=${encodeURIComponent(LEVEL_SLUG)}`,
      {
        headers,
        tags: { name: 'GET /api/sentences/v2/start' },
      }
    );

    startDuration.add(res.timings.duration);

    const ok = check(res, {
      'sentence audio start 200': (r) => r.status === 200,
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

    check({ sessionKey, answers, questions }, {
      'session key present': (x) => !!x.sessionKey,
      'questions returned': (x) => x.questions.length > 0,
      'answers built': (x) => x.answers.length > 0,
    });
  });

  if (!sessionKey || answers.length === 0 || questions.length === 0) {
    sleep(randomBetween(1, 4));
    return;
  }

  // Simulate the user going through the quiz question by question.
  // The real page autoplay-fetches audio per question and waits for user interaction.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const audioKey = q?.sentenceId ? `${q.sentenceId}.mp3` : null;

    if (FETCH_AUDIO && audioKey) {
      const audioRes = http.get(`${CDN_BASE}/audio/${audioKey}`, {
        headers: {
          Accept: 'audio/mpeg,*/*',
        },
        tags: { name: 'GET /audio/:sentenceId.mp3' },
      });

      audioDuration.add(audioRes.timings.duration);
      audioFilesFetched.add(1);

      check(audioRes, {
        'audio file fetch 200/206': (r) => r.status === 200 || r.status === 206,
      });
    }

    // User listens, thinks, taps an answer, sees feedback, then moves on.
    sleep(randomBetween(2, 6));
  }

  group('finalize sentence audio quiz', () => {
    const res = http.post(
      `${BASE_URL}/api/sentences/v2/finalize`,
      JSON.stringify({
        sessionKey,
        answers,
      }),
      {
        headers,
        tags: { name: 'POST /api/sentences/v2/finalize' },
      }
    );

    finalizeDuration.add(res.timings.duration);

    const ok = check(res, {
      'sentence audio finalize 200': (r) => r.status === 200,
    });

    if (ok) {
      quizzesFinalized.add(1);
    }
  });

  // Pause before the same user starts another quiz.
  sleep(randomBetween(5, 20));
}