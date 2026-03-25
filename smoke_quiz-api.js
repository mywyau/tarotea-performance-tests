import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

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

// ++++++++++++++++++++++++++++++

//Note: smoke tests

export const options = {
  scenarios: {
    quiz_journey: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: 20 },
      ],
      gracefulRampDown: '15s',
    },
  },
};

// ++++++++++++++++++++++++++++++

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

export default function () {
  const headers = buildHeaders();
  let selectedWordIds = [];

  group('load quiz', () => {
    const quizRes = http.get(`${BASE_URL}/api/vocab-quiz/${LEVEL_SLUG}`, { headers });
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

  // sleep(thinkTimeSeconds(10, 20));

  group('finalize quiz', () => {
    const payload = {
      mode: 'grind-level',
      answers: selectedWordIds.map((wordId, index) => ({
        wordId,
        correct: index % 2 === 0,
      })),
    };

    const finalizeRes = http.post(
      `${BASE_URL}/api/quiz/grind/finalize`,
      JSON.stringify(payload),
      { headers }
    );

    quizFinalizeDuration.add(finalizeRes.timings.duration);

    check(finalizeRes, {
      'finalize status 200': (r) => r.status === 200,
    });
  });

  sleep(1);
}