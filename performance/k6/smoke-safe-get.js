import { Counter } from "k6/metrics";
import { sleep } from "k6";
import {
  normalizeBaseUrl,
  discoverDefaultParams,
  paramsForEndpoint,
  requestEndpoint,
  safeGetEndpoints,
} from "./utils/endpoints.js";

const BASE_URL = normalizeBaseUrl(__ENV.BASE_URL);
const endpoints = JSON.parse(open("./endpoints.json"));
const SAFE_GET_ENDPOINTS = safeGetEndpoints(endpoints);

const skippedEndpoints = new Counter("safe_get_endpoints_skipped");

export const options = {
  scenarios: {
    smoke_safe_get_endpoints: {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 1),
      iterations: Number(__ENV.ITERATIONS || SAFE_GET_ENDPOINTS.length),
      maxDuration: __ENV.MAX_DURATION || "5m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: [`p(95)<${Number(__ENV.P95_THRESHOLD_MS || 1500)}`],
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

export function setup() {
  return discoverDefaultParams(BASE_URL, endpoints);
}

export default function (discoveredParams) {
  const endpoint = SAFE_GET_ENDPOINTS[__ITER % SAFE_GET_ENDPOINTS.length];
  const result = requestEndpoint(BASE_URL, endpoint, paramsForEndpoint(endpoint, discoveredParams || {}));

  if (result.skipped) {
    skippedEndpoints.add(1, {
      endpoint: endpoint.name,
      category: endpoint.category,
      reason: result.reason,
    });
  }

  sleep(Number(__ENV.SLEEP_SECONDS || 0.2));
}
