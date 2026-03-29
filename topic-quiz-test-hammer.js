import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const TOPIC_SLUG = __ENV.TOPIC_SLUG || 'survival-essentials';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('./tokens.json'));
});

const quizLoadDuration = new Trend('quiz_load_duration');
const quizFinalizeDuration = new Trend('quiz_finalize_duration');

console.log('Running topic:', TOPIC_SLUG);
console.log('Token count:', tokens.length);

function buildHeaders() {
  const token = tokens[(__VU - 1) % tokens.length];

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

function createAttemptId() {
  return `k6-topic-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function loadTopicQuiz(headers) {
  return http.get(`${BASE_URL}/api/topic/quiz/${TOPIC_SLUG}`, { headers });
}

function finalizeTopicQuiz(headers, payload) {
  return http.post(
    `${BASE_URL}/api/quiz/grind/finalize-v2`,
    JSON.stringify(payload),
    { headers }
  );
}

function getQuestions(quizJson) {
  return Array.isArray(quizJson?.questions) ? quizJson.questions : [];
}

function getWordId(question) {
  return question?.wordId || null;
}

// export const options = {
//   scenarios: {
//     topic_quiz_burst_1000: {
//       executor: 'ramping-vus',
//       startVUs: 1,
//       stages: [
//         { duration: '10s', target: 250 },
//         { duration: '10s', target: 1000 },
//         { duration: '20s', target: 1000 },
//         { duration: '10s', target: 0 },
//       ],
//       gracefulRampDown: '0s',
//     },
//   },

//   thresholds: {
//     http_req_duration: ['p(95)<1500', 'p(99)<3000'],
//     http_req_failed: ['rate<0.01'],
//     checks: ['rate>0.99'],

//     quiz_load_duration: [
//       'p(95)<800',
//       'p(99)<1200',
//     ],
//     quiz_finalize_duration: [
//       'p(95)<1000',
//       'p(99)<1500',
//     ],
//   },

//   summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
// };

export const options = {
  scenarios: {
    topic_quiz_burst_100: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '10s', target: 25 },
        { duration: '10s', target: 100 },
        { duration: '20s', target: 100 },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '0s',
    },
  },

  thresholds: {
    http_req_duration: ['p(95)<1500', 'p(99)<3000'],
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],

    quiz_load_duration: [
      'p(95)<800',
      'p(99)<1200',
    ],
    quiz_finalize_duration: [
      'p(95)<1000',
      'p(99)<1500',
    ],
  },

  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();
  let selectedWordIds = [];

  group('load topic quiz', () => {
    const quizRes = loadTopicQuiz(headers);

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

    const questions = getQuestions(quizJson);

    selectedWordIds = questions
      .map(getWordId)
      .filter(Boolean);

    check(quizJson, {
      'questions present': () => selectedWordIds.length > 0,
    });
  });

  if (selectedWordIds.length === 0) {
    return;
  }

  group('finalize topic quiz', () => {
    const payload = {
      attemptId: createAttemptId(),
      mode: 'grind-topic',
      answers: selectedWordIds.map((wordId, index) => ({
        wordId,
        correct: index % 2 === 0,
      })),
    };

    const finalizeRes = finalizeTopicQuiz(headers, payload);

    quizFinalizeDuration.add(finalizeRes.timings.duration);

    check(finalizeRes, {
      'finalize status 200': (r) => r.status === 200,
    });
  });

  // Tiny pause so one VU doesn't hammer unrealistically fast in a tight loop.
  sleep(0.2);
}