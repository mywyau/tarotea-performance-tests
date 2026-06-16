import { check } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";

const TOKEN_FILES = __ENV.AUTH_TOKENS_FILE
  ? [__ENV.AUTH_TOKENS_FILE]
  : [
      "../../../auth/tokens.json",
      "../../auth/tokens.json",
      "auth/tokens.json",
    ];
const fileTokens = new SharedArray("auth tokens", function () {
  if (__ENV.AUTH_TOKEN || __ENV.AUTH_TOKENS || __ENV.SESSION_COOKIE) {
    return [];
  }

  for (const tokenFile of TOKEN_FILES) {
    try {
      const parsed = JSON.parse(open(tokenFile));
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.filter(Boolean);
      }
    } catch (_) {
      // Try the next path. k6 resolves relative paths from imported modules
      // differently depending on execution/archive context.
    }
  }

  return [];
});

const envTokens = (__ENV.AUTH_TOKENS || "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);

function tokenIndex(length) {
  if (!length) {
    return 0;
  }

  const vu = typeof __VU === "number" ? __VU : 0;
  const iter = typeof __ITER === "number" ? __ITER : 0;
  return (vu + iter) % length;
}

export const DEFAULT_PARAMS = {
  id: __ENV.CONTENT_ID || __ENV.WORD_ID || "",
  wordId: __ENV.WORD_ID || __ENV.CONTENT_ID || "",
  sentenceId: __ENV.SENTENCE_ID || "",
  attemptId: __ENV.ATTEMPT_ID || "",
  topicSlug: __ENV.TOPIC_SLUG || "survival-essentials",
  slug: __ENV.SLUG || __ENV.TOPIC_SLUG || "survival-essentials",
  slugs: __ENV.LEVEL_SLUGS || "1",
  level: __ENV.LEVEL || "1",
  limit: Number(__ENV.LIMIT || 10),
  sessionId: __ENV.SESSION_ID || "",
  wordIds: __ENV.WORD_IDS || __ENV.WORD_ID || "",
};

export function normalizeBaseUrl(value) {
  if (!value) {
    throw new Error("BASE_URL is required, for example BASE_URL=https://www.tarotea.co.uk");
  }

  return value.replace(/\/+$/, "");
}

export function getAuthToken() {
  if (__ENV.AUTH_TOKEN) {
    return __ENV.AUTH_TOKEN;
  }

  if (envTokens.length) {
    return envTokens[tokenIndex(envTokens.length)];
  }

  if (fileTokens.length) {
    return fileTokens[tokenIndex(fileTokens.length)];
  }

  return "";
}

export function authHeaders() {
  const headers = {
    Accept: "application/json",
  };

  const token = getAuthToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (__ENV.SESSION_COOKIE) {
    headers.Cookie = __ENV.SESSION_COOKIE;
  }

  return headers;
}

export function hasAuth() {
  return Boolean(getAuthToken() || __ENV.SESSION_COOKIE);
}

export function safeGetEndpoints(endpoints) {
  return endpoints.filter((endpoint) => endpoint.safeForLoadTest === true && endpoint.method === "GET");
}

export function findEndpoint(endpoints, name) {
  const endpoint = endpoints.find((item) => item.name === name);

  if (!endpoint) {
    throw new Error(`Endpoint not found in manifest: ${name}`);
  }

  if (!endpoint.safeForLoadTest) {
    throw new Error(`Endpoint is not safe for load testing: ${name}`);
  }

  return endpoint;
}

export function renderEndpointPath(endpoint, params = {}) {
  const values = {
    ...DEFAULT_PARAMS,
    ...(endpoint.exampleParams || {}),
    ...params,
  };

  const missingPathParams = [];
  let path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    const value = values[key];

    if (value === undefined || value === null || value === "") {
      missingPathParams.push(key);
      return "";
    }

    return encodeURIComponent(String(value));
  });

  if (missingPathParams.length) {
    return { path: null, reason: `missing path params: ${missingPathParams.join(", ")}` };
  }

  const usedPathKeys = new Set(
    [...endpoint.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]),
  );
  const queryParams = {};

  for (const [key, value] of Object.entries(values)) {
    if (usedPathKeys.has(key)) continue;
    if (value === undefined || value === null || value === "") continue;

    if (endpoint.exampleParams && Object.prototype.hasOwnProperty.call(endpoint.exampleParams, key)) {
      queryParams[key] = value;
    }
  }

  const queryString = Object.entries(queryParams)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");

  if (queryString) {
    path = `${path}?${queryString}`;
  }

  return { path, reason: null };
}

export function requestEndpoint(baseUrl, endpoint, params = {}) {
  if (endpoint.authRequired && !hasAuth()) {
    return { skipped: true, reason: "missing AUTH_TOKEN, AUTH_TOKENS, AUTH_TOKENS_FILE, or SESSION_COOKIE" };
  }

  const rendered = renderEndpointPath(endpoint, params);
  if (!rendered.path) {
    return { skipped: true, reason: rendered.reason };
  }

  const res = http.get(`${baseUrl}${rendered.path}`, {
    headers: authHeaders(),
    tags: {
      endpoint: endpoint.name,
      category: endpoint.category,
      method: endpoint.method,
      path: endpoint.path,
      name: endpoint.name,
    },
  });

  check(res, {
    [`${endpoint.name} returned non-5xx`]: (r) => r.status < 500,
    [`${endpoint.name} returned expected auth status`]: (r) =>
      endpoint.authRequired ? r.status !== 401 && r.status !== 403 : r.status < 500,
  });

  return { skipped: false, response: res };
}

export function randomSleep(minSeconds, maxSeconds) {
  const min = Number(minSeconds);
  const max = Number(maxSeconds);
  return Math.random() * (max - min) + min;
}

function firstValueByKey(value, keys) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstValueByKey(item, keys);
      if (found) return found;
    }

    return "";
  }

  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) {
      return value[key];
    }
  }

  for (const item of Object.values(value)) {
    const found = firstValueByKey(item, keys);
    if (found) return found;
  }

  return "";
}

function parseJson(res) {
  try {
    return res.json();
  } catch (_) {
    return null;
  }
}

export function discoverDefaultParams(baseUrl, endpoints, params = {}) {
  const topicSlug = params.topicSlug || DEFAULT_PARAMS.topicSlug;
  const defaults = {
    wordId: __ENV.WORD_ID || "",
    sentenceId: __ENV.SENTENCE_ID || "",
  };

  if (!defaults.wordId) {
    const topicEndpoint = findEndpoint(endpoints, "Topic Content");
    const topic = requestEndpoint(baseUrl, topicEndpoint, { id: topicSlug });
    if (!topic.skipped && topic.response.status >= 200 && topic.response.status < 300) {
      defaults.wordId = firstValueByKey(parseJson(topic.response), ["wordId", "id"]);
    }
  }

  if (!defaults.sentenceId) {
    const sentenceEndpoint = findEndpoint(endpoints, "Topic Sentences");
    const sentences = requestEndpoint(baseUrl, sentenceEndpoint, { id: topicSlug });
    if (!sentences.skipped && sentences.response.status >= 200 && sentences.response.status < 300) {
      defaults.sentenceId = firstValueByKey(parseJson(sentences.response), ["sentenceId", "id"]);
    }
  }

  return {
    wordId: defaults.wordId,
    sentenceId: defaults.sentenceId,
    wordIds: defaults.wordId,
  };
}

export function paramsForEndpoint(endpoint, discoveredParams = {}) {
  const params = {};
  const wordId = __ENV.WORD_ID || discoveredParams.wordId || "";
  const sentenceId = __ENV.SENTENCE_ID || discoveredParams.sentenceId || "";

  if (endpoint.path.includes("/api/sentences/:id")) {
    params.id = sentenceId;
  } else if (endpoint.path.includes("/words/:id")) {
    params.id = wordId;
  }

  if (endpoint.path === "/api/word-unlocks" || endpoint.path.startsWith("/api/word-progress")) {
    params.wordIds = __ENV.WORD_IDS || wordId;
  }

  return params;
}
