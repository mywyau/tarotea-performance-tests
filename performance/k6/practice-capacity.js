import { fail, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";
import { bindLearnerToVu, randomSleep, requireLearnerPool } from "./utils/endpoints.js";
import { attemptId, positiveInt, read, requireStaging, save, topic, typingSave, typingStart, wordAnswers, wordSave, wordStart } from "./utils/practice.js";

requireStaging();
const mode = __ENV.LEARNER_MODE;
if (!["guest", "signed-in"].includes(mode)) throw new Error("Set LEARNER_MODE to guest or signed-in");
const profile = __ENV.PROFILE || "paced";
if (!["paced", "burst"].includes(profile)) throw new Error("PROFILE must be paced or burst");
const sessionSeconds = positiveInt("SESSION_SECONDS", 600);
const peak = positiveInt("TARGET_VUS", 1);
const burstRate = positiveInt("STARTS_PER_SECOND", 1);
const burstSeconds = positiveInt("BURST_SECONDS", 1);
const burstVus = Math.min(burstRate * burstSeconds, burstRate * (sessionSeconds + 5));
const grace = `${Math.ceil(sessionSeconds * 1.25) + 60}s`;
const started = new Counter("practice_started");
const completed = new Counter("practice_completed");
const success = new Rate("practice_success");
const startMs = new Trend("practice_start_ms", true);
const saveMs = new Trend("practice_save_ms", true);

export const options = {
  tags: { profile, learner_mode: mode },
  scenarios: {
    practice: profile === "paced" ? {
      executor: "ramping-vus", startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || "10m", target: peak },
        { duration: __ENV.STEADY_STATE || "20m", target: peak },
      ],
      gracefulStop: grace,
    } : {
      executor: "constant-arrival-rate", rate: burstRate, timeUnit: "1s",
      duration: `${burstSeconds}s`, preAllocatedVUs: burstVus, gracefulStop: grace,
    },
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds: {
    practice_started: [profile === "burst" ? `count>=${burstRate * burstSeconds}` : "count>0"],
    practice_completed: [profile === "burst" ? `count>=${burstRate * burstSeconds}` : "count>0"],
    practice_success: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    practice_start_ms: ["p(95)<1000"],
    ...(mode === "signed-in" ? { practice_save_ms: ["p(95)<1500"] } : {}),
    ...(profile === "burst" ? { dropped_iterations: ["count==0"] } : {}),
  },
};

export function setup() {
  if (mode === "signed-in") requireLearnerPool(profile === "paced" ? peak : burstVus);
}

export default function () {
  bindLearnerToVu();
  const typing = exec.scenario.iterationInTest % 2 === 1;
  const tags = { exercise: typing ? "typing" : "quiz" };
  let finished = false;
  try {
    const start = typing
      ? read(typingStart, { scope: "topic", slug: topic, variant: "chinese" })
      : read(wordStart, { topicSlug: topic });
    startMs.add(start.timings.duration, tags);
    const payload = start.json();
    let body;
    if (typing) {
      if (!payload.session?.words?.length) fail("Typing start returned no words");
      if (mode === "signed-in" && !payload.sessionKey) fail("Typing start returned no session key");
      body = { sessionKey: payload.sessionKey, attempts: payload.session.words.map(w => {
        if (!w.wordId) fail("Typing prompt has no word ID");
        return { wordId: w.wordId, passed: true, hintUsed: false };
      }) };
    } else {
      body = { attemptId: attemptId(), mode: "grind-topic", answers: wordAnswers(payload) };
    }
    started.add(1, tags);
    // The UI handles individual answers locally. A fixed delay preserves the burst shape.
    sleep(profile === "burst" ? sessionSeconds : randomSleep(0.8, 1.2) * sessionSeconds);
    if (mode === "signed-in") {
      const response = save(typing ? typingSave : wordSave, body);
      saveMs.add(response.timings.duration, tags);
      const ack = response.json();
      if (typing ? !Number.isFinite(ack.xpEarned) : ack.attemptId !== body.attemptId || !ack.queued) {
        fail("Unexpected practice save acknowledgement");
      }
    }
    completed.add(1, tags);
    finished = true;
  } finally {
    success.add(finished, tags);
  }
}
