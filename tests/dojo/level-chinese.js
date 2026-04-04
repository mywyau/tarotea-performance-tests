import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Trend, Counter } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const LEVEL_SLUG = __ENV.LEVEL_SLUG || 'level-one';
const CDN_BASE = __ENV.CDN_BASE || BASE_URL;

// fast defaults
const WORD_THINK_MIN = Number(__ENV.WORD_THINK_MIN || '0.02');
const WORD_THINK_MAX = Number(__ENV.WORD_THINK_MAX || '0.08');

const HINT_RATE = Number(__ENV.HINT_RATE || '0.15');

const FINALIZE_DELAY_MIN = Number(__ENV.FINALIZE_DELAY_MIN || '0.01');
const FINALIZE_DELAY_MAX = Number(__ENV.FINALIZE_DELAY_MAX || '0.05');

const SESSION_PAUSE_MIN = Number(__ENV.SESSION_PAUSE_MIN || '0.05');
const SESSION_PAUSE_MAX = Number(__ENV.SESSION_PAUSE_MAX || '0.15');

// optional: mimic page audio fetches
const FETCH_AUDIO = (__ENV.FETCH_AUDIO || 'false').toLowerCase() === 'true';

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const startDuration = new Trend('dojo_chinese_start_duration');
const finalizeDuration = new Trend('dojo_chinese_finalize_duration');
const audioDuration = new Trend('dojo_chinese_audio_duration');

const sessionsStarted = new Counter('dojo_chinese_sessions_started');
const sessionsFinalized = new Counter('dojo_chinese_sessions_finalized');
const audioFilesFetched = new Counter('dojo_chinese_audio_files_fetched');

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

function randomBool(probability) {
  return Math.random() < probability;
}

function buildHeaders() {
  const tokenIndex = (__VU + __ITER) % tokens.length;
  const token = tokens[tokenIndex];

  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

export const options = {
  scenarios: {
    dojo_chinese_flow: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '30s', target: 20 },
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
    dojo_chinese_start_duration: ['p(95)<1500', 'p(99)<2500'],
    dojo_chinese_finalize_duration: ['p(95)<2500', 'p(99)<5000'],
    http_req_duration: ['p(95)<2000'],

    // only meaningful if FETCH_AUDIO=true
    dojo_chinese_audio_duration: ['p(95)<1500'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  group('start chinese dojo session', function () {
    const startRes = http.get(
      `${BASE_URL}/api/typing/levels/v2/start?scope=level&slug=${encodeURIComponent(LEVEL_SLUG)}&variant=chinese`,
      { headers, tags: { name: 'GET /api/typing/levels/v2/start?variant=chinese' } }
    );

    startDuration.add(startRes.timings.duration);

    const ok = check(startRes, {
      'start status is 200': (r) => r.status === 200,
      'start has json body': (r) => !!r.body,
    });

    if (!ok) {
      return;
    }

    const payload = startRes.json();

    check(payload, {
      'has sessionKey': (p) => !!p.sessionKey,
      'has session words': (p) => Array.isArray(p?.session?.words),
      'has total words': (p) => typeof p?.session?.totalWords === 'number',
    });

    const sessionKey = payload.sessionKey;
    const words = payload?.session?.words || [];

    if (!sessionKey || !words.length) {
      return;
    }

    sessionsStarted.add(1);

    const attempts = [];

    group('simulate chinese typing session', function () {
      for (const word of words) {
        // page marks each word as passed=true once correctly typed
        attempts.push({
          wordId: word.wordId,
          passed: true,
          hintUsed: randomBool(HINT_RATE),
        });

        if (FETCH_AUDIO && word?.wordId) {
          const audioRes = http.get(`${CDN_BASE}/audio/${word.wordId}.mp3`, {
            headers: {
              Accept: 'audio/mpeg,*/*',
            },
            tags: { name: 'GET /audio/:wordId.mp3' },
          });

          audioDuration.add(audioRes.timings.duration);
          audioFilesFetched.add(1);

          check(audioRes, {
            'audio file fetch 200/206': (r) => r.status === 200 || r.status === 206,
          });
        }

        sleep(randomBetween(WORD_THINK_MIN, WORD_THINK_MAX));
      }
    });

    sleep(randomBetween(FINALIZE_DELAY_MIN, FINALIZE_DELAY_MAX));

    group('finalize chinese dojo session', function () {
      const finalizeRes = http.post(
        `${BASE_URL}/api/typing/levels/v2/finalize`,
        JSON.stringify({
          sessionKey,
          attempts,
        }),
        {
          headers,
          tags: { name: 'POST /api/typing/levels/v2/finalize' },
        }
      );

      finalizeDuration.add(finalizeRes.timings.duration);

      const finalizeOk = check(finalizeRes, {
        'finalize status is 200': (r) => r.status === 200,
        'finalize has json body': (r) => !!r.body,
      });

      if (!finalizeOk) {
        return;
      }

      const result = finalizeRes.json();

      check(result, {
        'finalize has session result': (p) => !!p?.session,
        'finalize has correctCount': (p) => typeof p?.session?.correctCount === 'number',
        'finalize has totalWords': (p) => typeof p?.session?.totalWords === 'number',
        'finalize has xpEarned': (p) => typeof p?.session?.xpEarned === 'number',
      });

      sessionsFinalized.add(1);
    });
  });

  sleep(randomBetween(SESSION_PAUSE_MIN, SESSION_PAUSE_MAX));
}