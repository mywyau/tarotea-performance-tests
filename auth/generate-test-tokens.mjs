// generate-test-tokens.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

loadEnvFile();

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;

const MGMT_CLIENT_ID = process.env.AUTH0_MGMT_CLIENT_ID;
const MGMT_CLIENT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET;

const API_AUDIENCE = process.env.AUTH0_AUDIENCE;

const TEST_APP_CLIENT_ID = process.env.AUTH0_TEST_APP_CLIENT_ID;
const TEST_APP_CLIENT_SECRET = process.env.AUTH0_TEST_APP_CLIENT_SECRET;

const AUTH0_DB_CONNECTION = process.env.AUTH0_DB_CONNECTION;
const APP_BASE_URL = process.env.APP_BASE_URL;

const USER_COUNT = Number(process.env.USER_COUNT || 500);

// Delay between each full user bootstrap
const USER_DELAY_MS = Number(process.env.USER_DELAY_MS || 750);

// Retry settings for Auth0/API rate limiting
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const BASE_BACKOFF_MS = Number(process.env.BASE_BACKOFF_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(res, attempt) {
  const retryAfter = res.headers.get('retry-after');

  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) {
      return seconds * 1000;
    }
  }

  // exponential backoff: 1000, 2000, 4000, ...
  return BASE_BACKOFF_MS * 2 ** attempt;
}

async function fetchWithRateLimitRetry(url, options, label = 'request') {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) {
      return res;
    }

    if (attempt === MAX_RETRIES) {
      throw new Error(`${label} failed: hit rate limit too many times`);
    }

    const delayMs = getRetryDelayMs(res, attempt);
    console.warn(`${label} rate limited (429). Retrying in ${delayMs}ms...`);
    await sleep(delayMs);
  }

  throw new Error(`${label} failed unexpectedly`);
}

async function getManagementToken() {
  const res = await fetchWithRateLimitRetry(
    `https://${AUTH0_DOMAIN}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: MGMT_CLIENT_ID,
        client_secret: MGMT_CLIENT_SECRET,
        audience: `https://${AUTH0_DOMAIN}/api/v2/`,
        grant_type: 'client_credentials',
      }),
    },
    'Mgmt token'
  );

  if (!res.ok) {
    throw new Error(`Mgmt token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function createUser(mgmtToken, email, password) {
  const res = await fetchWithRateLimitRetry(
    `https://${AUTH0_DOMAIN}/api/v2/users`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mgmtToken}`,
      },
      body: JSON.stringify({
        email,
        password,
        connection: AUTH0_DB_CONNECTION,
        email_verified: true,
      }),
    },
    `Create user ${email}`
  );

  if (res.status === 409) {
    const lookup = await fetchWithRateLimitRetry(
      `https://${AUTH0_DOMAIN}/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${mgmtToken}`,
        },
      },
      `Lookup user ${email}`
    );

    if (!lookup.ok) {
      throw new Error(`User lookup failed: ${lookup.status} ${await lookup.text()}`);
    }

    const users = await lookup.json();
    if (!users.length) {
      throw new Error(`User exists but lookup returned nothing for ${email}`);
    }

    return {
      sub: users[0].user_id,
      email: users[0].email,
    };
  }

  if (!res.ok) {
    throw new Error(`Create user failed: ${res.status} ${await res.text()}`);
  }

  const user = await res.json();

  return {
    sub: user.user_id,
    email: user.email,
  };
}

async function getUserAccessToken(username, password) {
  const res = await fetchWithRateLimitRetry(
    `https://${AUTH0_DOMAIN}/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
        username,
        password,
        audience: API_AUDIENCE,
        scope: 'openid profile email',
        realm: AUTH0_DB_CONNECTION,
        client_id: TEST_APP_CLIENT_ID,
        client_secret: TEST_APP_CLIENT_SECRET,
      }),
    },
    `User token ${username}`
  );

  if (!res.ok) {
    throw new Error(`User token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function bootstrapAppUser(accessToken, email) {
  const res = await fetchWithRateLimitRetry(
    `${APP_BASE_URL}/api/auth/post-login`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    },
    `post-login ${email}`
  );

  if (!res.ok) {
    throw new Error(`post-login failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function main() {
  const mgmtToken = await getManagementToken();
  const tokens = [];

  for (let i = 1; i <= USER_COUNT; i++) {
    const email = `loadtest+${i}@example.com`;
    const password = `PerfTest!${i}Abc123`;

    const user = await createUser(mgmtToken, email, password);
    const token = await getUserAccessToken(email, password);
    await bootstrapAppUser(token, user.email);

    tokens.push(token);
    console.log(`bootstrapped ${email}`);

    if (i < USER_COUNT) {
      await sleep(USER_DELAY_MS);
    }
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const tokensPath = path.join(__dirname, 'tokens.json');

  await fs.writeFile(tokensPath, JSON.stringify(tokens, null, 2));

  // await fs.writeFile('./tokens.json', JSON.stringify(tokens, null, 2));
  console.log(`Wrote ${tokens.length} tokens to tokens.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});