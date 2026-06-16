import { check, group, sleep } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";
import {
  authHeaders,
  getAuthToken,
  hasAuth,
  normalizeBaseUrl,
  randomSleep,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const CHECK_POST_LOGIN = (__ENV.CHECK_POST_LOGIN || "false").toLowerCase() === "true";

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 401));

const authFlowRequests = new Counter("auth_flow_requests");
const authFlowUnexpectedStatusRate = new Rate("auth_flow_unexpected_status_rate");

export const options = {
  scenarios: {
    auth_flow_check: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 1),
      iterations: Number(__ENV.ITERATIONS || 10),
      maxDuration: __ENV.MAX_DURATION || "2m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${Number(__ENV.P95_THRESHOLD_MS || 1500)}`],
    auth_flow_unexpected_status_rate: ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

function request(method, path, options = {}) {
  const res = http.request(method, `${BASE_URL}${path}`, options.body || null, {
    headers: options.headers || {},
    tags: {
      endpoint: options.endpoint,
      category: "auth",
      method,
      path,
      name: options.endpoint,
      auth_case: options.authCase,
    },
  });

  const expected = options.expectedStatuses || [200];
  const unexpected = !expected.includes(res.status);
  authFlowRequests.add(1, {
    endpoint: options.endpoint,
    auth_case: options.authCase,
    status: String(res.status),
  });
  authFlowUnexpectedStatusRate.add(unexpected, {
    endpoint: options.endpoint,
    auth_case: options.authCase,
    status: String(res.status),
  });

  return res;
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

export function setup() {
  if (!hasAuth()) {
    throw new Error("AUTH_TOKEN, AUTH_TOKENS, AUTH_TOKENS_FILE, SESSION_COOKIE, or auth/tokens.json is required");
  }

  return {};
}

export default function () {
  group("protected endpoint rejects missing auth", () => {
    const res = request("GET", "/api/meV2", {
      endpoint: "Current User V2",
      authCase: "missing",
      expectedStatuses: [401],
    });

    check(res, {
      "missing auth returns 401": (r) => r.status === 401,
    });
  });

  group("protected endpoint rejects malformed bearer token", () => {
    const res = request("GET", "/api/meV2", {
      endpoint: "Current User V2",
      authCase: "malformed",
      headers: {
        Authorization: "Bearer not-a-jwt",
        Accept: "application/json",
      },
      expectedStatuses: [401],
    });

    check(res, {
      "malformed bearer token returns 401": (r) => r.status === 401,
    });
  });

  let me = null;

  group("generated token authenticates app user", () => {
    const token = getAuthToken();
    const res = request("GET", "/api/meV2", {
      endpoint: "Current User V2",
      authCase: "valid",
      headers: authHeaders(),
      expectedStatuses: [200],
    });
    me = parseJson(res);

    check({ token, res, me }, {
      "auth token is present": (value) => Boolean(value.token),
      "valid auth returns 200": (value) => value.res.status === 200,
      "me response has user id": (value) => typeof value.me?.id === "string" && value.me.id.length > 0,
      "me response has email": (value) => typeof value.me?.email === "string" && value.me.email.includes("@"),
      "me response has entitlement": (value) => Boolean(value.me?.entitlement?.plan),
    });
  });

  group("generated token accesses protected read endpoints", () => {
    const aiUsage = request("GET", "/api/ai/usage", {
      endpoint: "AI Usage",
      authCase: "valid",
      headers: authHeaders(),
      expectedStatuses: [200],
    });
    const aiUsageBody = parseJson(aiUsage);

    check({ aiUsage, aiUsageBody }, {
      "ai usage returns 200": (value) => value.aiUsage.status === 200,
      "ai usage has numeric limit": (value) => Number.isFinite(Number(value.aiUsageBody?.limit)),
      "ai usage has numeric remaining": (value) => Number.isFinite(Number(value.aiUsageBody?.remaining)),
    });

    const dailyStats = request("GET", "/api/daily/jyutping/v2/stats", {
      endpoint: "Daily Jyutping Stats V2",
      authCase: "valid",
      headers: authHeaders(),
      expectedStatuses: [200],
    });
    const dailyStatsBody = parseJson(dailyStats);

    check({ dailyStats, dailyStatsBody }, {
      "daily stats returns 200": (value) => value.dailyStats.status === 200,
      "daily stats has total xp": (value) => Number.isFinite(Number(value.dailyStatsBody?.total_xp)),
    });
  });

  if (CHECK_POST_LOGIN) {
    group("post-login is idempotent for generated user", () => {
      const res = request("POST", "/api/auth/post-login", {
        endpoint: "Auth Post Login",
        authCase: "valid",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: me?.email }),
        expectedStatuses: [200],
      });
      const body = parseJson(res);

      check({ res, body, me }, {
        "post-login returns 200": (value) => value.res.status === 200,
        "post-login returns same user id": (value) => value.body?.id === value.me?.id,
      });
    });
  }

  sleep(randomSleep(0.5, 1.5));
}
