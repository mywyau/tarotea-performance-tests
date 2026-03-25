// generate-test-tokens.mjs
import fs from 'node:fs/promises';

import { loadEnvFile } from 'node:process';

loadEnvFile();

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;

const MGMT_CLIENT_ID = process.env.AUTH0_MGMT_CLIENT_ID;
const MGMT_CLIENT_SECRET = process.env.AUTH0_MGMT_CLIENT_SECRET;

const API_AUDIENCE = process.env.AUTH0_AUDIENCE;

const TEST_APP_CLIENT_ID = process.env.AUTH0_TEST_APP_CLIENT_ID;
const TEST_APP_CLIENT_SECRET = process.env.AUTH0_TEST_APP_CLIENT_SECRET;

const AUTH0_DB_CONNECTION = process.env.AUTH0_DB_CONNECTION;
const APP_BASE_URL = process.env.APP_BASE_URL;

const USER_COUNT = Number(process.env.USER_COUNT || 20);

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

async function createUser(mgmtToken, email, password) {
  const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/users`, {
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
  });

  if (res.status === 409) {
    // user already exists; look them up
    const lookup = await fetch(
      `https://${AUTH0_DOMAIN}/api/v2/users-by-email?email=${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${mgmtToken}`,
        },
      }
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

async function bootstrapAppUser(sub, email) {
  const res = await fetch(`${APP_BASE_URL}/api/auth/post-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sub, email }),
  });

  if (!res.ok) {
    throw new Error(`post-login failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

async function getUserAccessToken(username, password) {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
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
  });

  if (!res.ok) {
    throw new Error(`User token failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  return json.access_token;
}

async function main() {
  const mgmtToken = await getManagementToken();
  const tokens = [];

  for (let i = 1; i <= USER_COUNT; i++) {
    const email = `loadtest+${i}@example.com`;
    const password = `PerfTest!${i}Abc123`;

    const user = await createUser(mgmtToken, email, password);
    await bootstrapAppUser(user.sub, user.email);

    const token = await getUserAccessToken(email, password);
    tokens.push(token);

    console.log(`bootstrapped ${email}`);
  }

  await fs.writeFile('./tokens.json', JSON.stringify(tokens, null, 2));
  console.log(`Wrote ${tokens.length} tokens to tokens.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});