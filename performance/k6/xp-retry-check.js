import { check, fail, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";
import { requireLearnerToken } from "./utils/endpoints.js";
import { attemptId, positiveInt, progress, read, requireStaging, save, topic, wordAnswers, wordSave, wordStart } from "./utils/practice.js";

requireStaging();
const timeout = positiveInt("XP_WAIT_SECONDS", 60);
const observe = positiveInt("XP_OBSERVE_SECONDS", 10);
const verified = new Counter("xp_retries_verified");
const visibleMs = new Trend("xp_visible_ms", true);

export const options = {
  scenarios: { retry: {
    executor: "per-vu-iterations", vus: 1, iterations: 1,
    maxDuration: `${timeout + observe + 180}s`,
  } },
  thresholds: { xp_retries_verified: ["count==1"], checks: ["rate==1"], http_req_failed: ["rate==0"] },
};

export function setup() {
  requireLearnerToken();
}

function assert(name, condition) {
  if (!check(condition, { [name]: value => value === true })) fail(name);
}

function snapshot(wordId) {
  const row = read(progress, { wordIds: wordId }).json()[wordId];
  assert("progress has numeric XP and streak", Number.isFinite(row?.xp) && Number.isFinite(row?.streak));
  return row;
}

export default function () {
  const payload = read(wordStart, { topicSlug: topic }).json();
  const { wordId } = wordAnswers(payload)[0];
  const before = snapshot(wordId);
  // Vocabulary awards 5 XP plus 2 per prior streak step, up to 5 steps.
  const expectedXp = before.xp + 5 + 2 * Math.min(before.streak, 5);
  const expectedStreak = before.streak + 1;
  const body = { attemptId: attemptId(), mode: "grind-topic", answers: [{ wordId, correct: true }] };

  const sentAt = Date.now();
  const first = save(wordSave, body).json();
  assert("fresh attempt queued", first.attemptId === body.attemptId && first.queued === true && first.deduped === false);
  const retry = save(wordSave, body).json();
  assert("same attempt deduplicated", retry.attemptId === body.attemptId && retry.queued === false && retry.deduped === true);

  let observedAt = 0;
  while (true) {
    const state = snapshot(wordId);
    const now = Date.now();
    if (state.xp === expectedXp && state.streak === expectedStreak) {
      if (!observedAt) {
        assert("award visible before timeout", now - sentAt <= timeout * 1000);
        observedAt = now;
        visibleMs.add(now - sentAt);
      }
      if (now - observedAt >= observe * 1000) break;
    } else {
      assert("progress stayed at baseline pending one award", !observedAt && state.xp === before.xp && state.streak === before.streak);
      assert("worker applied XP before timeout", now - sentAt < timeout * 1000);
    }
    sleep(1);
  }
  verified.add(1);
}
