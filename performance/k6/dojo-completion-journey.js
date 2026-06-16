import { check, group, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  findEndpoint,
  normalizeBaseUrl,
  normalizeLevelSlug,
  postJsonEndpoint,
  randomSleep,
  requestEndpoint,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const endpoints = JSON.parse(open("./endpoints.json"));

const TOPIC_SLUG = __ENV.TOPIC_SLUG || "survival-essentials";
const LEVEL_SLUG = normalizeLevelSlug(__ENV.LEVEL_SLUG || __ENV.LEVEL || "level-one");
const ANSWER_MODE = (__ENV.ANSWER_MODE || "mixed").toLowerCase();
const HINT_RATE = Number(__ENV.HINT_RATE || 0.1);
const ENABLED_FLOWS = (__ENV.DOJO_FLOWS || [
  "topic-jyutping",
  "topic-chinese",
  "level-jyutping",
  "level-chinese",
  "topic-sentence",
  "level-sentence",
].join(","))
  .split(",")
  .map((flow) => flow.trim())
  .filter(Boolean);

const skippedRequests = new Counter("dojo_completion_requests_skipped");
const completedDojoSessions = new Counter("dojo_completion_completed");
const dojoSessionDuration = new Trend("dojo_completion_session_duration");

const api = {
  topicStart: findEndpoint(endpoints, "Typing Topic Start V2"),
  topicFinalize: findEndpoint(endpoints, "Typing Topic Finalize V2", { allowUnsafe: true }),
  levelStart: findEndpoint(endpoints, "Typing Levels Start V2"),
  levelFinalize: findEndpoint(endpoints, "Typing Levels Finalize V2", { allowUnsafe: true }),
  sentenceStart: findEndpoint(endpoints, "Typing Sentences Start V2"),
  sentenceFinalize: findEndpoint(endpoints, "Typing Sentences Finalize V2", { allowUnsafe: true }),
};

export const options = {
  scenarios: {
    dojo_completion_journey: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_UP || "30s", target: Number(__ENV.TARGET_VUS || 3) },
        { duration: __ENV.STEADY_STATE || "2m", target: Number(__ENV.TARGET_VUS || 3) },
        { duration: __ENV.RAMP_DOWN || "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.03"],
    http_req_duration: [`p(95)<${Number(__ENV.P95_THRESHOLD_MS || 2000)}`],
    endpoint_unexpected_status_rate: [`rate<${Number(__ENV.UNEXPECTED_STATUS_RATE_THRESHOLD || 0.03)}`],
    checks: ["rate>0.99"],
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

function recordSkip(result, endpoint) {
  if (!result.skipped) return false;
  skippedRequests.add(1, {
    endpoint: endpoint.name,
    category: endpoint.category,
    reason: result.reason,
  });
  return true;
}

function decidePassed(index) {
  switch (ANSWER_MODE) {
    case "correct":
      return true;
    case "wrong":
      return false;
    case "random":
      return Math.random() >= 0.5;
    case "mixed":
    default:
      return index % 2 === 0;
  }
}

function hintUsed() {
  return Math.random() < HINT_RATE;
}

function wordAttempts(words) {
  return words
    .filter((word) => word?.wordId)
    .map((word, index) => ({
      wordId: word.wordId,
      passed: decidePassed(index),
      hintUsed: hintUsed(),
    }));
}

function sentenceAttempts(sentences) {
  return sentences
    .filter((sentence) => sentence?.sentenceId && sentence?.sourceWordId)
    .map((sentence, index) => ({
      sentenceId: sentence.sentenceId,
      sourceWordId: sentence.sourceWordId,
      passed: decidePassed(index),
      hintUsed: hintUsed(),
    }));
}

function completeWordDojo({ flow, startEndpoint, finalizeEndpoint, params }) {
  const startedAt = Date.now();
  const start = requestEndpoint(BASE_URL, startEndpoint, params);
  if (recordSkip(start, startEndpoint) || start.response.status !== 200) return;

  const payload = parseJson(start.response);
  const sessionKey = payload?.sessionKey;
  const words = Array.isArray(payload?.session?.words) ? payload.session.words : [];
  const attempts = wordAttempts(words);

  check({ sessionKey, words, attempts }, {
    [`${flow} has session key`]: (value) => !!value.sessionKey,
    [`${flow} has words`]: (value) => value.words.length > 0,
    [`${flow} has attempts`]: (value) => value.attempts.length > 0,
  });

  if (!sessionKey || !attempts.length) return;

  sleep(randomSleep(0.5, 1.5));

  const finalize = postJsonEndpoint(BASE_URL, finalizeEndpoint, { sessionKey, attempts });
  if (recordSkip(finalize, finalizeEndpoint)) return;

  check(finalize.response, {
    [`${flow} finalize 200`]: (res) => res.status === 200,
  });

  if (finalize.response.status === 200) {
    completedDojoSessions.add(1, { flow });
    dojoSessionDuration.add(Date.now() - startedAt, { flow });
  }
}

function completeSentenceDojo({ flow, params }) {
  const startedAt = Date.now();
  const start = requestEndpoint(BASE_URL, api.sentenceStart, params);
  if (recordSkip(start, api.sentenceStart) || start.response.status !== 200) return;

  const payload = parseJson(start.response);
  const sessionKey = payload?.sessionKey;
  const sentences = Array.isArray(payload?.session?.sentences) ? payload.session.sentences : [];
  const attempts = sentenceAttempts(sentences);

  check({ sessionKey, sentences, attempts }, {
    [`${flow} has session key`]: (value) => !!value.sessionKey,
    [`${flow} has sentences`]: (value) => value.sentences.length > 0,
    [`${flow} has attempts`]: (value) => value.attempts.length > 0,
  });

  if (!sessionKey || !attempts.length) return;

  sleep(randomSleep(0.5, 1.5));

  const finalize = postJsonEndpoint(BASE_URL, api.sentenceFinalize, { sessionKey, attempts });
  if (recordSkip(finalize, api.sentenceFinalize)) return;

  check(finalize.response, {
    [`${flow} finalize 200`]: (res) => res.status === 200,
  });

  if (finalize.response.status === 200) {
    completedDojoSessions.add(1, { flow });
    dojoSessionDuration.add(Date.now() - startedAt, { flow });
  }
}

const flows = {
  "topic-jyutping": () => completeWordDojo({
    flow: "topic-jyutping",
    startEndpoint: api.topicStart,
    finalizeEndpoint: api.topicFinalize,
    params: { scope: "topic", slug: TOPIC_SLUG, variant: "jyutping" },
  }),
  "topic-chinese": () => completeWordDojo({
    flow: "topic-chinese",
    startEndpoint: api.topicStart,
    finalizeEndpoint: api.topicFinalize,
    params: { scope: "topic", slug: TOPIC_SLUG, variant: "chinese" },
  }),
  "level-jyutping": () => completeWordDojo({
    flow: "level-jyutping",
    startEndpoint: api.levelStart,
    finalizeEndpoint: api.levelFinalize,
    params: { scope: "level", slug: LEVEL_SLUG, variant: "jyutping" },
  }),
  "level-chinese": () => completeWordDojo({
    flow: "level-chinese",
    startEndpoint: api.levelStart,
    finalizeEndpoint: api.levelFinalize,
    params: { scope: "level", slug: LEVEL_SLUG, variant: "chinese" },
  }),
  "topic-sentence": () => completeSentenceDojo({
    flow: "topic-sentence",
    params: { scope: "topic", slug: TOPIC_SLUG, variant: "chinese" },
  }),
  "level-sentence": () => completeSentenceDojo({
    flow: "level-sentence",
    params: { scope: "level", slug: LEVEL_SLUG, variant: "chinese" },
  }),
};

export default function () {
  for (const flow of ENABLED_FLOWS) {
    const runFlow = flows[flow];
    if (!runFlow) continue;

    group(`complete ${flow} dojo`, runFlow);
    sleep(randomSleep(0.5, 1.25));
  }

  sleep(randomSleep(1, 3));
}
