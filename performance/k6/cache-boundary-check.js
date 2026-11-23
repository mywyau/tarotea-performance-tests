import { check } from "k6";
import http from "k6/http";
import { Rate } from "k6/metrics";
import {
  authHeaders,
  hasAuth,
  normalizeBaseUrl,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const TOPIC_SLUG = __ENV.TOPIC_SLUG || "survival-essentials";
const LEVEL_SLUG = __ENV.LEVEL_SLUG || "level-one";

const cacheBoundaryFailureRate = new Rate("cache_boundary_failure_rate");

export const options = {
  scenarios: {
    cache_boundary_check: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "1m",
    },
  },
  thresholds: {
    cache_boundary_failure_rate: ["rate==0"],
    http_req_failed: ["rate<0.5"],
  },
};

function cacheControl(response) {
  return String(response.headers["Cache-Control"] || "").toLowerCase();
}

function record(name, response, assertions) {
  const passed = check(response, {
    ...assertions,
    [`${name} has a cache-control header`]: (res) =>
      cacheControl(res).length > 0,
  });

  cacheBoundaryFailureRate.add(!passed, { boundary: name });
}

function publicContent(name, path) {
  const response = http.get(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
    tags: { name, boundary: "public-content" },
  });

  record(name, response, {
    [`${name} returns 200`]: (res) => res.status === 200,
    [`${name} permits shared caching`]: (res) =>
      cacheControl(res).includes("public") &&
      cacheControl(res).includes("s-maxage=600"),
  });
}

function privateResponse(
  name,
  path,
  expectedStatus,
  headers = { Accept: "application/json" },
) {
  const response = http.get(`${BASE_URL}${path}`, {
    headers,
    tags: { name, boundary: "private-api" },
  });

  record(name, response, {
    [`${name} returns ${expectedStatus}`]: (res) =>
      res.status === expectedStatus,
    [`${name} forbids storage`]: (res) =>
      cacheControl(res).includes("private") &&
      cacheControl(res).includes("no-store"),
  });
}

function privateHtml(name, path) {
  const response = http.get(`${BASE_URL}${path}`, {
    headers: { Accept: "text/html" },
    tags: { name, boundary: "private-html" },
  });

  record(name, response, {
    [`${name} returns 200`]: (res) => res.status === 200,
    [`${name} forbids shared caching`]: (res) =>
      cacheControl(res).includes("private") &&
      cacheControl(res).includes("no-cache"),
  });
}

export default function () {
  privateHtml("HTML application shell", "/");

  publicContent(
    "public topic content",
    `/api/index/topics/${encodeURIComponent(TOPIC_SLUG)}`,
  );
  publicContent(
    "public level content",
    `/api/index/levels/${encodeURIComponent(LEVEL_SLUG)}`,
  );
  publicContent(
    "public vocab content",
    `/api/vocab-quiz/${encodeURIComponent(LEVEL_SLUG)}`,
  );

  privateResponse(
    "anonymous topic quiz",
    `/api/topic/quiz/v2/${encodeURIComponent(TOPIC_SLUG)}`,
    200,
  );
  privateResponse(
    "missing public content",
    "/api/index/topics/__cache-boundary-missing__",
    404,
  );
  privateResponse("unauthenticated user endpoint", "/api/meV2", 401);

  if (hasAuth()) {
    privateResponse(
      "authenticated user endpoint",
      "/api/meV2",
      200,
      authHeaders(),
    );
  }
}
