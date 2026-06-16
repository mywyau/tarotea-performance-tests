import { group, sleep } from "k6";
import { Counter } from "k6/metrics";
import {
  discoverDefaultParams,
  findEndpoint,
  normalizeBaseUrl,
  normalizeLevelSlug,
  randomSleep,
  requestEndpoint,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const endpoints = JSON.parse(open("./endpoints.json"));
const TOPIC_SLUG = __ENV.TOPIC_SLUG || "survival-essentials";
const TOPIC_SENTENCE_SLUG = __ENV.TOPIC_SENTENCE_SLUG || `${TOPIC_SLUG}-sentences`;
const LEVEL_SLUG = normalizeLevelSlug(__ENV.LEVEL_SLUG || __ENV.LEVEL || "level-one");

const skippedRequests = new Counter("learner_journey_requests_skipped");

const journey = {
  health: findEndpoint(endpoints, "Health Check"),
  currentUsers: findEndpoint(endpoints, "Current Users Count"),
  totalStats: findEndpoint(endpoints, "Total User Stats"),
  topicContent: findEndpoint(endpoints, "Topic Content"),
  topicQuiz: findEndpoint(endpoints, "Topic Word Quiz V2"),
  topicAudioQuiz: findEndpoint(endpoints, "Topic Audio Quiz V2"),
  topicSentences: findEndpoint(endpoints, "Topic Sentences"),
  levelContent: findEndpoint(endpoints, "Index Level Content"),
  wordDetail: findEndpoint(endpoints, "Word Detail"),
  sentenceDetail: findEndpoint(endpoints, "Sentence Detail"),
  me: findEndpoint(endpoints, "Current User V2"),
  accessTopic: findEndpoint(endpoints, "Access Topic"),
  accessLevel: findEndpoint(endpoints, "Access Level"),
  wordUnlocks: findEndpoint(endpoints, "Word Unlock Summary"),
  wordProgressV3: findEndpoint(endpoints, "Word Progress V3"),
  userStatsV2: findEndpoint(endpoints, "User Stats V2"),
  dailyJyutpingStats: findEndpoint(endpoints, "Daily Jyutping Stats V2"),
  typingTopicStart: findEndpoint(endpoints, "Typing Topic Start V2"),
  typingLevelStart: findEndpoint(endpoints, "Typing Levels Start V2"),
  sentenceStart: findEndpoint(endpoints, "Sentences Start V3"),
  sentenceTopicStart: findEndpoint(endpoints, "Sentence Topics Start V3"),
};

export const options = {
  scenarios: {
    learner_journey: {
      executor: "ramping-vus",
      startVUs: 1,
      stages: [
        { duration: __ENV.RAMP_UP || "30s", target: Number(__ENV.TARGET_VUS || 10) },
        { duration: __ENV.STEADY_STATE || "2m", target: Number(__ENV.TARGET_VUS || 10) },
        { duration: __ENV.RAMP_DOWN || "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    http_req_duration: [`p(95)<${Number(__ENV.P95_THRESHOLD_MS || 1800)}`],
    endpoint_unexpected_status_rate: [`rate<${Number(__ENV.UNEXPECTED_STATUS_RATE_THRESHOLD || 0.02)}`],
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

function get(endpoint, params = {}) {
  const result = requestEndpoint(BASE_URL, endpoint, params);

  if (result.skipped) {
    skippedRequests.add(1, {
      endpoint: endpoint.name,
      category: endpoint.category,
      reason: result.reason,
    });
  }

  return result;
}

export function setup() {
  return discoverDefaultParams(BASE_URL, endpoints, {
    topicSlug: TOPIC_SLUG,
    topicSentenceSlug: TOPIC_SENTENCE_SLUG,
  });
}

export default function (discoveredParams) {
  const wordId = __ENV.WORD_ID || discoveredParams?.wordId || "";

  group("landing and public discovery", () => {
    get(journey.health);
    get(journey.currentUsers);
    get(journey.totalStats);
    sleep(randomSleep(0.2, 0.8));
  });

  group("browse topic and level content", () => {
    get(journey.topicContent, { id: TOPIC_SLUG });
    get(journey.topicSentences, { id: TOPIC_SENTENCE_SLUG });
    get(journey.levelContent, { id: LEVEL_SLUG });
    get(journey.wordDetail, { id: wordId });
    get(journey.sentenceDetail, { id: LEVEL_SLUG });
    sleep(randomSleep(1, 3));
  });

  group("start practice without finalizing", () => {
    get(journey.topicQuiz, { topicSlug: TOPIC_SLUG });
    sleep(randomSleep(1, 2));
    get(journey.topicAudioQuiz, { topicSlug: TOPIC_SLUG });
    sleep(randomSleep(1, 2));
  });

  group("authenticated learner dashboard", () => {
    get(journey.me);
    get(journey.accessTopic, { slug: TOPIC_SLUG });
    get(journey.accessLevel, { slug: LEVEL_SLUG });
    get(journey.wordUnlocks, { wordIds: wordId });
    get(journey.wordProgressV3, { wordIds: wordId });
    get(journey.userStatsV2);
    get(journey.dailyJyutpingStats);
    sleep(randomSleep(1, 3));
  });

  group("authenticated practice starts", () => {
    get(journey.typingTopicStart, { scope: "topic", slug: TOPIC_SLUG, variant: "jyutping" });
    get(journey.typingLevelStart, { scope: "level", slug: LEVEL_SLUG, variant: "jyutping" });
    get(journey.sentenceStart, { scope: "level", slug: LEVEL_SLUG });
    get(journey.sentenceTopicStart, { scope: "topic", slug: TOPIC_SLUG });
    sleep(randomSleep(2, 5));
  });
}
