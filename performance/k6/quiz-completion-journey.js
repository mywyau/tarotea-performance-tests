import { check, group, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import {
  discoverDefaultParams,
  findEndpoint,
  normalizeBaseUrl,
  postJsonEndpoint,
  randomSleep,
  requestEndpoint,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const endpoints = JSON.parse(open("./endpoints.json"));

const TOPIC_SLUG = __ENV.TOPIC_SLUG || "survival-essentials";
const LEVEL_SLUG = (() => {
  const raw = __ENV.LEVEL_SLUG || __ENV.LEVEL || "level-one";
  const byNumber = {
    "1": "level-one",
    "2": "level-two",
    "3": "level-three",
    "4": "level-four",
    "5": "level-five",
    "6": "level-six",
    "7": "level-seven",
    "8": "level-eight",
    "9": "level-nine",
    "10": "level-ten",
  };

  return byNumber[raw] || raw;
})();
const ANSWER_MODE = (__ENV.ANSWER_MODE || "mixed").toLowerCase();

const skippedRequests = new Counter("quiz_completion_requests_skipped");
const completedQuizzes = new Counter("quiz_completion_completed");
const wordQuizDuration = new Trend("quiz_completion_word_quiz_duration");
const topicSentenceDuration = new Trend("quiz_completion_topic_sentence_duration");
const levelSentenceDuration = new Trend("quiz_completion_level_sentence_duration");

const api = {
  topicWordStart: findEndpoint(endpoints, "Topic Word Quiz V2"),
  topicWordFinalize: findEndpoint(endpoints, "Quiz Grind Finalize V5", { allowUnsafe: true }),
  topicSentenceStart: findEndpoint(endpoints, "Sentence Topics Start V3"),
  topicSentenceFinalize: findEndpoint(endpoints, "Sentence Topics Finalize V3", { allowUnsafe: true }),
  levelSentenceStart: findEndpoint(endpoints, "Sentences Start V3"),
  levelSentenceFinalize: findEndpoint(endpoints, "Sentences Finalize V3", { allowUnsafe: true }),
};

export const options = {
  scenarios: {
    quiz_completion_journey: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_UP || "30s", target: Number(__ENV.TARGET_VUS || 5) },
        { duration: __ENV.STEADY_STATE || "2m", target: Number(__ENV.TARGET_VUS || 5) },
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

function decideCorrect(index) {
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

function attemptId(prefix) {
  return `${prefix}-${__VU}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function runTopicWordQuiz() {
  const startedAt = Date.now();
  const start = requestEndpoint(BASE_URL, api.topicWordStart, { topicSlug: TOPIC_SLUG });
  if (recordSkip(start, api.topicWordStart) || start.response.status !== 200) return;

  const payload = parseJson(start.response);
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  const answers = questions
    .filter((question) => question?.wordId)
    .map((question, index) => ({
      wordId: question.wordId,
      correct: decideCorrect(index),
    }));

  check({ questions, answers }, {
    "topic word quiz has questions": (value) => value.questions.length > 0,
    "topic word quiz has answers": (value) => value.answers.length > 0,
  });

  if (!answers.length) return;

  sleep(randomSleep(0.5, 1.5));

  const finalize = postJsonEndpoint(
    BASE_URL,
    api.topicWordFinalize,
    {
      attemptId: attemptId("k6-topic-word"),
      mode: "grind-topic",
      answers,
    },
  );
  if (recordSkip(finalize, api.topicWordFinalize)) return;

  check(finalize.response, {
    "topic word finalize 200": (res) => res.status === 200,
  });

  if (finalize.response.status === 200) completedQuizzes.add(1, { quiz: "topic-word" });
  wordQuizDuration.add(Date.now() - startedAt);
}

function runSentenceQuiz(startEndpoint, finalizeEndpoint, startParams, quizTag) {
  const startedAt = Date.now();
  const start = requestEndpoint(BASE_URL, startEndpoint, startParams);
  if (recordSkip(start, startEndpoint) || start.response.status !== 200) return;

  const payload = parseJson(start.response);
  const sessionKey = payload?.sessionKey;
  const questions = Array.isArray(payload?.quiz?.questions) ? payload.quiz.questions : [];
  const answers = questions
    .filter((question) => question?.wordId && question?.sentenceId)
    .map((question, index) => ({
      wordId: question.wordId,
      sentenceId: question.sentenceId,
      correct: decideCorrect(index),
    }));

  check({ sessionKey, questions, answers }, {
    [`${quizTag} has session key`]: (value) => !!value.sessionKey,
    [`${quizTag} has questions`]: (value) => value.questions.length > 0,
    [`${quizTag} has answers`]: (value) => value.answers.length > 0,
  });

  if (!sessionKey || !answers.length) return;

  sleep(randomSleep(0.5, 1.5));

  const finalize = postJsonEndpoint(
    BASE_URL,
    finalizeEndpoint,
    {
      sessionKey,
      answers,
    },
  );
  if (recordSkip(finalize, finalizeEndpoint)) return;

  check(finalize.response, {
    [`${quizTag} finalize 200`]: (res) => res.status === 200,
  });

  if (finalize.response.status === 200) completedQuizzes.add(1, { quiz: quizTag });

  const duration = Date.now() - startedAt;
  if (quizTag === "topic-sentence") topicSentenceDuration.add(duration);
  if (quizTag === "level-sentence") levelSentenceDuration.add(duration);
}

export function setup() {
  return discoverDefaultParams(BASE_URL, endpoints, { topicSlug: TOPIC_SLUG });
}

export default function () {
  group("complete topic word quiz", runTopicWordQuiz);

  group("complete topic sentence quiz", () => {
    runSentenceQuiz(
      api.topicSentenceStart,
      api.topicSentenceFinalize,
      { scope: "topic", slug: TOPIC_SLUG },
      "topic-sentence",
    );
  });

  group("complete level sentence quiz", () => {
    runSentenceQuiz(
      api.levelSentenceStart,
      api.levelSentenceFinalize,
      { scope: "level", slug: LEVEL_SLUG },
      "level-sentence",
    );
  });

  sleep(randomSleep(1, 3));
}
