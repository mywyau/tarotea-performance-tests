import { fail } from "k6";
import { findEndpoint, normalizeBaseUrl, postJsonEndpoint, requestEndpoint } from "./endpoints.js";

export const base = normalizeBaseUrl(__ENV.BASE_URL);
const manifest = JSON.parse(open("../endpoints.json"));
export const topic = __ENV.TOPIC_SLUG || "survival-essentials";
export const wordStart = findEndpoint(manifest, "Topic Word Quiz V2");
export const wordSave = findEndpoint(manifest, "Quiz Grind Finalize V5", { allowUnsafe: true });
export const progress = findEndpoint(manifest, "Word Progress V3");
export const typingStart = findEndpoint(manifest, "Typing Topic Start V2");
export const typingSave = findEndpoint(manifest, "Typing Topic Finalize V2", { allowUnsafe: true });

export function requireStaging() {
  // These scenarios were designed for staging or a local fixture.
  const host = base.match(/^https?:\/\/([^/:?#]+)/i)?.[1]?.toLowerCase();
  if (!host || ["tarotea.co.uk", "www.tarotea.co.uk"].includes(host)) {
    throw new Error("Set BASE_URL to the staging deployment or local fixture.");
  }
}

function successful(result, endpoint) {
  if (result.skipped || result.response.status !== 200) {
    fail(`${endpoint.name}: ${result.skipped ? result.reason : result.response.status}`);
  }
  return result.response;
}

export function read(endpoint, params) {
  return successful(requestEndpoint(base, endpoint, params), endpoint);
}

export function save(endpoint, body) {
  return successful(postJsonEndpoint(base, endpoint, body), endpoint);
}

export function wordAnswers(payload) {
  if (!payload.questions?.length) fail("Word quiz returned no questions");
  return payload.questions.map((q, i) => {
    if (!q.wordId) fail("Quiz question has no word ID");
    return { wordId: q.wordId, correct: i % 4 !== 3 };
  });
}

export function attemptId() {
  return `k6-practice-${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function positiveInt(name, fallback) {
  const value = Number(__ENV[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
