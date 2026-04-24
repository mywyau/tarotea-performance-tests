import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.APP_BASE_URL || 'https://www.tarotea.co.uk';
const CDN_BASE = (__ENV.CDN_BASE || 'https://cdn.tarotea.co.uk').replace(/\/$/, '');
const WORD_ID = __ENV.WORD_ID;
const DO_TONE_CHECK = (__ENV.DO_TONE_CHECK || 'true').toLowerCase() === 'true';

if (!WORD_ID) {
  throw new Error('WORD_ID env var is required, e.g. WORD_ID=abc123');
}

const tokens = new SharedArray('tokens', function () {
  return JSON.parse(open('../../auth/tokens.json'));
});

if (!tokens.length) {
  throw new Error('tokens.json is empty');
}

const wordLoadDuration = new Trend('tone_word_load_duration');
const audioFetchDuration = new Trend('tone_reference_audio_fetch_duration');
const toneCheckDuration = new Trend('tone_word_check_duration');

const wordsLoaded = new Counter('tone_words_loaded');
const referenceAudioFetched = new Counter('tone_reference_audio_fetched');
const toneChecksSubmitted = new Counter('tone_checks_submitted');

function getToken() {
  const index = (__VU + __ITER) % tokens.length;
  return tokens[index];
}

function buildHeaders() {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${getToken()}`,
  };
}

function randomBetween(minSeconds, maxSeconds) {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

export const options = {
  scenarios: {
    tone_word_page: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 15 },
        { duration: '20s', target: 30 },
        { duration: '20s', target: 45 },
        { duration: '40s', target: 45 },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.03'],
    http_req_duration: ['p(95)<2500', 'p(99)<4500'],
    checks: ['rate>0.97'],

    'http_req_duration{name:GET /api/words/:wordId}': ['p(95)<1200'],
    'http_req_duration{name:GET /audio/:filename}': ['p(95)<1500'],
    'http_req_duration{name:POST /api/pronunciation-tone-word-v1}': ['p(95)<2000'],

    tone_word_load_duration: ['p(95)<1200'],
    tone_reference_audio_fetch_duration: ['p(95)<1500'],
    tone_word_check_duration: ['p(95)<2000'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

export default function () {
  const headers = buildHeaders();

  let expectedJyutping = '';
  let audioFilename = '';
  let audioBody = null;

  group('load tone word metadata', () => {
    const res = http.get(
      `${BASE_URL}/api/words/${encodeURIComponent(WORD_ID)}`,
      {
        tags: { name: 'GET /api/words/:wordId' },
      }
    );

    wordLoadDuration.add(res.timings.duration);

    const ok = check(res, {
      'tone word metadata 200': (r) => r.status === 200,
    });

    if (!ok) {
      return;
    }

    wordsLoaded.add(1);

    let json;
    try {
      json = res.json();
    } catch (_) {
      return;
    }

    expectedJyutping = json?.jyutping || '';
    audioFilename = json?.audio?.word || '';
  });

  if (audioFilename) {
    group('fetch tone reference audio', () => {
      const res = http.get(`${CDN_BASE}/audio/${encodeURIComponent(audioFilename)}`, {
        responseType: 'binary',
        tags: { name: 'GET /audio/:filename' },
      });

      audioFetchDuration.add(res.timings.duration);

      const ok = check(res, {
        'reference audio 200/206': (r) => r.status === 200 || r.status === 206,
      });

      if (!ok) {
        return;
      }

      referenceAudioFetched.add(1);
      audioBody = res.body;
    });
  }

  if (DO_TONE_CHECK && expectedJyutping && audioBody) {
    group('submit tone check', () => {
      const payload = {
        audio: http.file(audioBody, 'tone-word.webm', 'audio/webm'),
        expectedJyutping,
        pitchSummary: JSON.stringify([]),
        referenceSummary: JSON.stringify([]),
      };

      const res = http.post(
        `${BASE_URL}/api/pronunciation-tone-word-v1`,
        payload,
        {
          headers,
          tags: { name: 'POST /api/pronunciation-tone-word-v1' },
        }
      );

      toneCheckDuration.add(res.timings.duration);

      const ok = check(res, {
        'tone check non-5xx': (r) => r.status < 500,
      });

      if (ok) {
        toneChecksSubmitted.add(1);
      }
    });
  }

  sleep(randomBetween(1, 3));
}
