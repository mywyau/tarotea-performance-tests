// delete-test-users.mjs
import fs from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

loadEnvFile();

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const MGMT_CLIENT_ID = process.env.AUTH0_MGMT_CLIENT_ID;
const MGMT_CLIENT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET;
const USER_COUNT = Number(process.env.USER_COUNT || 500);

async function getManagementToken() {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: MGMT_CLIENT_ID,
      client_secret: MGMT_CLIENT_SECRET,
      audience: `https://${AUTH0_DOMAIN}/api/v2/`,
      grant_type: 'client_credentials',
    }),
  });

  if (!res.ok) {
    throw new Error(`Mgmt token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return json.access_token;
}

function computeRateLimitDelayMs(res, attempt) {
  const resetHeader = res.headers.get('x-ratelimit-reset');

  if (resetHeader) {
    const resetSeconds = Number(resetHeader);
    if (!Number.isNaN(resetSeconds)) {
      const delayMs = resetSeconds * 1000 - Date.now() + 500;
      return Math.max(delayMs, 1500);
    }
  }

  // fallback exponential backoff
  return Math.min(1000 * 2 ** attempt, 15000);
}

async function fetchWith429Retry(url, options, label, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) {
      return res;
    }

    if (attempt === maxRetries) {
      throw new Error(`${label} failed after retries: 429 ${await res.text()}`);
    }

    // const waitMs = computeRateLimitDelayMs(res, attempt);
    console.log(`${label}: hit 429, waiting ${1500}ms before retry...`);
    await sleep(1500);
  }

  throw new Error(`${label}: unexpected retry failure`);
}

async function findUsersByEmail(mgmtToken, email) {

  const res = await fetchWith429Retry(
    `https://${AUTH0_DOMAIN}/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
    {
      headers: {
        Authorization: `Bearer ${mgmtToken}`,
      },
    },
    `Lookup ${email}`
  );

  if (!res.ok) {
    throw new Error(`Lookup failed for ${email}: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function deleteUser(mgmtToken, userId) {
  const res = await fetchWith429Retry(
    `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${mgmtToken}`,
      },
    },
    `Delete ${userId}`
  );

  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed for ${userId}: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const mgmtToken = await getManagementToken();

  for (let i = 1; i <= USER_COUNT; i++) {

    const email = `loadtest+${i}@example.com`;
    await sleep(1000);
    const users = await findUsersByEmail(mgmtToken, email);

    if (users.length === 0) {
      console.log(`No Auth0 user found for ${email}`);
      await sleep(500);
      continue;
    }

    for (const user of users) {
      await deleteUser(mgmtToken, user.user_id);
      console.log(`Deleted Auth0 user ${email} (${user.user_id})`);
      await sleep(500);
    }
  }

  await fs.rm('../../auth/tokens.json', { force: true });
  console.log('Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});