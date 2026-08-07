import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AccountStore } from '../src/account-store.js';
import {
  GOOGLE_ISSUER,
  GoogleAuthError,
  GoogleAuthService,
  type GoogleAuthorizationRequest,
  type GoogleCallbackRequest,
  type GoogleIdentity,
  type GoogleOidcAdapter,
} from '../src/google-oidc.js';
import { startPartModeServer, type RunningPartModeServer } from '../src/server.js';

type JsonObject = Record<string, unknown>;

function check(name: string, condition: boolean): asserts condition {
  if (!condition) throw new Error(`OIDC smoke failed: ${name}`);
}

function record(value: unknown, name: string): JsonObject {
  check(name, Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  return value as JsonObject;
}

async function readJson(response: Response, name: string): Promise<JsonObject> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${name} returned invalid JSON: ${text.slice(0, 200)}`);
  }
  return record(parsed, `${name} returns an object`);
}

function setCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  if (values.length > 0) return values;
  const combined = response.headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookiePair(response: Response, name: string): string {
  for (const value of setCookieHeaders(response)) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;]*)`));
    if (match?.[1] !== undefined) return `${name}=${match[1]}`;
  }
  throw new Error(`OIDC smoke failed: response did not set ${name}`);
}

function jsonHeaders(origin: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };
}

class FakeGoogleAdapter implements GoogleOidcAdapter {
  readonly authorizationRequests: GoogleAuthorizationRequest[] = [];
  readonly callbackRequests: GoogleCallbackRequest[] = [];
  readonly identities = new Map<string, GoogleIdentity>();

  async authorizationUrl(request: GoogleAuthorizationRequest): Promise<URL> {
    this.authorizationRequests.push({ ...request });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: 'partmode-oidc-smoke',
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url;
  }

  async exchangeCallback(request: GoogleCallbackRequest): Promise<GoogleIdentity> {
    this.callbackRequests.push({ ...request, callbackUrl: new URL(request.callbackUrl) });
    const codes = request.callbackUrl.searchParams.getAll('code');
    const issuers = request.callbackUrl.searchParams.getAll('iss');
    if (codes.length !== 1 || issuers.length !== 1 || issuers[0] !== GOOGLE_ISSUER) {
      throw new Error('fake provider rejected callback parameters');
    }
    const identity = this.identities.get(codes[0] ?? '');
    if (!identity) throw new Error('fake provider rejected authorization code');
    return identity;
  }
}

function identity(subject: string, displayName: string): GoogleIdentity {
  return { provider: 'google', issuer: GOOGLE_ISSUER, subject, displayName };
}

type StartedFlow = {
  response: Response;
  authorizationUrl: URL;
  bindingCookie: string;
  state: string;
  nonce: string;
};

const stateDir = mkdtempSync(resolve(tmpdir(), 'partmode-oidc-smoke-'));
const suffix = randomBytes(5).toString('hex');
const adapter = new FakeGoogleAdapter();
let clock = Date.now();
const googleAuth = new GoogleAuthService({
  adapter,
  now: () => new Date(clock),
});
let running: RunningPartModeServer | undefined;

try {
  const boundedAuth = new GoogleAuthService({ adapter: new FakeGoogleAdapter(), maxTransactions: 2 });
  const firstReservedStart = boundedAuth.begin('sign-in', 'http://127.0.0.1/auth/google/callback');
  const secondReservedStart = boundedAuth.begin('sign-in', 'http://127.0.0.1/auth/google/callback');
  let capacityError: unknown;
  try {
    await boundedAuth.begin('sign-in', 'http://127.0.0.1/auth/google/callback');
  } catch (error) {
    capacityError = error;
  }
  check(
    'concurrent Google starts cannot exceed transaction capacity',
    capacityError instanceof GoogleAuthError && capacityError.code === 'GOOGLE_AUTH_BUSY',
  );
  await Promise.all([firstReservedStart, secondReservedStart]);
  boundedAuth.close();

  const legacyDatabasePath = resolve(stateDir, 'legacy-v1.sqlite');
  const legacyPassword = `Legacy migration passphrase ${suffix}`;
  const legacySalt = randomBytes(16);
  const legacyDigest = scryptSync(legacyPassword, legacySalt, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  legacyDatabase.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_scheme TEXT NOT NULL,
      password_salt BLOB NOT NULL,
      password_digest BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK (length(name) BETWEEN 3 AND 40),
      CHECK (password_scheme = 'scrypt-v1'),
      CHECK (length(password_salt) = 16),
      CHECK (length(password_digest) = 32)
    );
  `);
  legacyDatabase.prepare(`
    INSERT INTO accounts(
      id, name, display_name, password_scheme, password_salt, password_digest, created_at
    ) VALUES (?, ?, NULL, 'scrypt-v1', ?, ?, ?)
  `).run('00000000-0000-4000-8000-000000000001', `legacy-${suffix}`, legacySalt, legacyDigest, Date.now());
  legacyDatabase.close();
  const migratedStore = AccountStore.open({
    filename: legacyDatabasePath,
    pepper: randomBytes(32),
  });
  const migratedAccount = await migratedStore.authenticateAccount(`legacy-${suffix}`, legacyPassword);
  check('v1 passphrase database migrates without changing account ID', migratedAccount?.id === '00000000-0000-4000-8000-000000000001');
  check('v1 migration preserves passphrase sign-in', migratedAccount?.hasPassphrase === true);
  migratedStore.close();
  const migratedDatabase = new DatabaseSync(legacyDatabasePath);
  const migratedColumns = migratedDatabase.prepare('PRAGMA table_info(accounts)').all() as Array<{ name?: unknown }>;
  const identityTable = migratedDatabase.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_identities'
  `).get();
  check('v1 migration adds password method marker', migratedColumns.some((column) => column.name === 'password_enabled'));
  check('v1 migration creates external identity table', Boolean(identityTable));
  migratedDatabase.close();

  running = await startPartModeServer({
    distDir: resolve('dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir,
    googleAuth,
  });
  const origin = running.url;
  const url = (path: string) => new URL(path, origin).href;

  const startGoogle = async (): Promise<StartedFlow> => {
    const response = await fetch(url('/auth/google/start'), { redirect: 'manual' });
    check('Google start returns a temporary redirect', response.status === 302);
    check('Google start is not cached', response.headers.get('cache-control') === 'no-store');
    const authorizationUrl = new URL(response.headers.get('location') ?? '');
    check('Google start uses the real Google authorization origin', authorizationUrl.origin === 'https://accounts.google.com');
    check('Google start uses authorization code flow', authorizationUrl.searchParams.get('response_type') === 'code');
    check('Google start requests only OpenID and profile scopes', authorizationUrl.searchParams.get('scope') === 'openid profile');
    check('Google start never requests email', !authorizationUrl.searchParams.get('scope')?.split(' ').includes('email'));
    check('Google start uses PKCE S256', authorizationUrl.searchParams.get('code_challenge_method') === 'S256');
    const state = authorizationUrl.searchParams.get('state') ?? '';
    const nonce = authorizationUrl.searchParams.get('nonce') ?? '';
    check('Google start has an opaque state', /^[A-Za-z0-9_-]{43}$/.test(state));
    check('Google start has an opaque nonce', /^[A-Za-z0-9_-]{43}$/.test(nonce));
    const bindingCookie = cookiePair(response, 'partmode_oidc_dev');
    check('Google binding cookie is HttpOnly', setCookieHeaders(response).some((value) => /HttpOnly/i.test(value)));
    check('Google binding cookie is SameSite Lax', setCookieHeaders(response).some((value) => /SameSite=Lax/i.test(value)));
    check('Google binding cookie is short lived', setCookieHeaders(response).some((value) => /Max-Age=(?:[1-5][0-9]{2}|600)/i.test(value)));
    return { response, authorizationUrl, bindingCookie, state, nonce };
  };

  const callback = async (
    flow: StartedFlow,
    code: string,
    cookie = flow.bindingCookie,
    extra: Record<string, string> = {},
  ): Promise<Response> => {
    const callbackUrl = new URL('/auth/google/callback', origin);
    callbackUrl.search = new URLSearchParams({
      code,
      state: flow.state,
      iss: GOOGLE_ISSUER,
      ...extra,
    }).toString();
    return fetch(callbackUrl, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: 'manual',
    });
  };

  adapter.identities.set('new-google-code', identity(`google-new-${suffix}`, 'Ada Partmaker'));
  const missingCookieFlow = await startGoogle();
  const exchangesBeforeMismatch = adapter.callbackRequests.length;
  const missingCookie = await callback(missingCookieFlow, 'new-google-code', '');
  check('missing browser binding fails closed', missingCookie.status === 303 && missingCookie.headers.get('location') === '/account?auth=google-failed');
  check('missing browser binding never reaches token exchange', adapter.callbackRequests.length === exchangesBeforeMismatch);
  const replayAfterMismatch = await callback(missingCookieFlow, 'new-google-code');
  check('mismatched transaction is consumed against replay', replayAfterMismatch.headers.get('location') === '/account?auth=google-failed');

  const cancelledFlow = await startGoogle();
  const cancelledUrl = new URL('/auth/google/callback', origin);
  cancelledUrl.search = new URLSearchParams({ error: 'access_denied', state: cancelledFlow.state }).toString();
  const cancelled = await fetch(cancelledUrl, { headers: { Cookie: cancelledFlow.bindingCookie }, redirect: 'manual' });
  check('provider cancellation is typed for the account UI', cancelled.headers.get('location') === '/account?auth=google-cancelled');

  const expiredFlow = await startGoogle();
  clock += 11 * 60 * 1_000;
  const expired = await callback(expiredFlow, 'new-google-code');
  check('expired Google transaction fails closed', expired.headers.get('location') === '/account?auth=google-expired');
  clock = Date.now();

  const newFlow = await startGoogle();
  const newCallback = await callback(newFlow, 'new-google-code');
  check('new Google identity creates a PartMode session', newCallback.status === 303 && newCallback.headers.get('location') === '/account?auth=google-created');
  const googleSession = cookiePair(newCallback, 'partmode_account_dev');
  check('callback clears the temporary binding cookie', setCookieHeaders(newCallback).some((value) => /^partmode_oidc_dev=;/i.test(value)));
  const accountAfterGoogle = await readJson(
    await fetch(url('/api/v1/account'), { headers: { Cookie: googleSession } }),
    'Google account status',
  );
  check('Google account is authenticated', accountAfterGoogle.authenticated === true);
  const googleAccount = record(accountAfterGoogle.account, 'Google account payload exists');
  const googleAccountId = googleAccount.id;
  check('Google account has no passphrase', googleAccount.hasPassphrase === false);
  check('Google profile name is used only for display', googleAccount.displayName === 'Ada Partmaker');
  check('Google identity metadata omits subject and email', !JSON.stringify(accountAfterGoogle).includes(`google-new-${suffix}`) && !Object.hasOwn(googleAccount, 'email'));
  const googleCsrf = accountAfterGoogle.csrfToken;
  check('Google account receives a CSRF token', typeof googleCsrf === 'string');

  const unlinkOnlyGoogle = await readJson(
    await fetch(url('/api/v1/identities/google'), {
      method: 'DELETE',
      headers: jsonHeaders(origin, {
        Cookie: googleSession,
        'X-PartMode-CSRF': googleCsrf as string,
      }),
      body: '{}',
    }),
    'last Google method unlink',
  );
  check('only sign-in method cannot be removed', unlinkOnlyGoogle.error === 'LAST_AUTH_METHOD');

  const keyCreation = await readJson(
    await fetch(url('/api/v1/agent-keys'), {
      method: 'POST',
      headers: jsonHeaders(origin, {
        Cookie: googleSession,
        'X-PartMode-CSRF': googleCsrf as string,
      }),
      body: JSON.stringify({ label: 'Google OIDC smoke agent', access: 'edit' }),
    }),
    'Google account agent key creation',
  );
  check('Google account can create an agent key', typeof keyCreation.rawKey === 'string');

  const repeatFlow = await startGoogle();
  adapter.identities.set('repeat-google-code', identity(`google-new-${suffix}`, 'Changed Provider Name'));
  const repeatCallback = await callback(repeatFlow, 'repeat-google-code');
  check('repeat Google sign-in succeeds', repeatCallback.headers.get('location') === '/account?auth=google-signed-in');
  const repeatedSession = cookiePair(repeatCallback, 'partmode_account_dev');
  const repeatedAccount = await readJson(
    await fetch(url('/api/v1/account'), { headers: { Cookie: repeatedSession } }),
    'repeated Google account status',
  );
  check('repeat Google sign-in preserves immutable PartMode account ID', record(repeatedAccount.account, 'repeated account').id === googleAccountId);
  check('repeat Google sign-in preserves agent keys', Array.isArray(repeatedAccount.keys) && repeatedAccount.keys.length === 1);
  const replay = await callback(repeatFlow, 'repeat-google-code');
  check('successful state cannot be replayed', replay.headers.get('location') === '/account?auth=google-failed');

  const passphraseName = `linked-${suffix}`;
  const passphrase = `PartMode linked account passphrase ${suffix}`;
  const passphraseSignupResponse = await fetch(url('/api/v1/accounts'), {
    method: 'POST',
    headers: jsonHeaders(origin),
    body: JSON.stringify({ name: passphraseName, password: passphrase }),
  });
  const passphraseSignup = await readJson(passphraseSignupResponse, 'passphrase account signup');
  const passphraseSession = cookiePair(passphraseSignupResponse, 'partmode_account_dev');
  const passphraseCsrf = passphraseSignup.csrfToken as string;
  const passphraseId = record(passphraseSignup.account, 'passphrase account exists').id;
  check('passphrase regression remains enabled', record(passphraseSignup.account, 'passphrase account payload').hasPassphrase === true);

  adapter.identities.set('link-code', identity(`google-link-${suffix}`, 'Linked Google Name'));
  const linkStartResponse = await fetch(url('/api/v1/auth/google/link'), {
    method: 'POST',
    headers: jsonHeaders(origin, {
      Cookie: passphraseSession,
      'X-PartMode-CSRF': passphraseCsrf,
    }),
    body: '{}',
  });
  const linkStartBody = await readJson(linkStartResponse, 'explicit Google link start');
  const linkAuthorizationUrl = new URL(linkStartBody.authorizationUrl as string);
  const linkFlow: StartedFlow = {
    response: linkStartResponse,
    authorizationUrl: linkAuthorizationUrl,
    bindingCookie: cookiePair(linkStartResponse, 'partmode_oidc_dev'),
    state: linkAuthorizationUrl.searchParams.get('state') ?? '',
    nonce: linkAuthorizationUrl.searchParams.get('nonce') ?? '',
  };
  const linkedCallback = await callback(linkFlow, 'link-code', `${passphraseSession}; ${linkFlow.bindingCookie}`);
  check('explicit linking succeeds', linkedCallback.headers.get('location') === '/account?auth=google-linked');
  const linkedSession = cookiePair(linkedCallback, 'partmode_account_dev');
  const linkedAccount = await readJson(
    await fetch(url('/api/v1/account'), { headers: { Cookie: linkedSession } }),
    'linked account status',
  );
  check('link preserves existing PartMode account ID', record(linkedAccount.account, 'linked account').id === passphraseId);
  check('linked account keeps passphrase', record(linkedAccount.account, 'linked account passphrase').hasPassphrase === true);
  check('linked account reports Google', record(record(linkedAccount.authMethods, 'auth methods').google, 'Google auth method').linked === true);

  const linkedSignInFlow = await startGoogle();
  adapter.identities.set('linked-signin-code', identity(`google-link-${suffix}`, 'Linked Google Name'));
  const linkedSignIn = await callback(linkedSignInFlow, 'linked-signin-code');
  const linkedSignInSession = cookiePair(linkedSignIn, 'partmode_account_dev');
  const linkedSignInAccount = await readJson(
    await fetch(url('/api/v1/account'), { headers: { Cookie: linkedSignInSession } }),
    'linked identity sign-in',
  );
  check('linked Google identity signs into original passphrase account', record(linkedSignInAccount.account, 'linked sign-in account').id === passphraseId);

  const otherName = `other-${suffix}`;
  const otherPassphrase = `PartMode other account passphrase ${suffix}`;
  const otherSignupResponse = await fetch(url('/api/v1/accounts'), {
    method: 'POST',
    headers: jsonHeaders(origin),
    body: JSON.stringify({ name: otherName, password: otherPassphrase }),
  });
  const otherSignup = await readJson(otherSignupResponse, 'other account signup');
  const otherSession = cookiePair(otherSignupResponse, 'partmode_account_dev');
  const otherLinkStartResponse = await fetch(url('/api/v1/auth/google/link'), {
    method: 'POST',
    headers: jsonHeaders(origin, {
      Cookie: otherSession,
      'X-PartMode-CSRF': otherSignup.csrfToken as string,
    }),
    body: '{}',
  });
  const otherLinkStart = await readJson(otherLinkStartResponse, 'cross-account link start');
  const otherAuthorizationUrl = new URL(otherLinkStart.authorizationUrl as string);
  const otherFlow: StartedFlow = {
    response: otherLinkStartResponse,
    authorizationUrl: otherAuthorizationUrl,
    bindingCookie: cookiePair(otherLinkStartResponse, 'partmode_oidc_dev'),
    state: otherAuthorizationUrl.searchParams.get('state') ?? '',
    nonce: otherAuthorizationUrl.searchParams.get('nonce') ?? '',
  };
  adapter.identities.set('conflict-code', identity(`google-link-${suffix}`, 'Same Google Identity'));
  const conflict = await callback(otherFlow, 'conflict-code', `${otherSession}; ${otherFlow.bindingCookie}`);
  check('one Google identity cannot link across accounts', conflict.headers.get('location') === '/account?auth=google-already-used');

  const sameNameFlow = await startGoogle();
  adapter.identities.set('same-name-code', identity(`google-different-${suffix}`, 'Ada Partmaker'));
  const sameNameCallback = await callback(sameNameFlow, 'same-name-code');
  const sameNameSession = cookiePair(sameNameCallback, 'partmode_account_dev');
  const sameNameAccount = await readJson(
    await fetch(url('/api/v1/account'), { headers: { Cookie: sameNameSession } }),
    'same profile name identity',
  );
  check('matching profile names never merge accounts', record(sameNameAccount.account, 'same-name account').id !== googleAccountId);

  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(url('/auth/google/start'), {
      headers: { 'X-Forwarded-For': '203.0.113.77' },
      redirect: 'manual',
    });
    check(`Google start rate-limit allowance ${attempt + 1}`, response.status === 302);
  }
  const rateLimitedStart = await fetch(url('/auth/google/start'), {
    headers: { 'X-Forwarded-For': '203.0.113.77' },
    redirect: 'manual',
  });
  check('Google start rate limits transaction allocation', rateLimitedStart.status === 429);

  check('OIDC adapter receives stored nonce for validation', adapter.callbackRequests.every((request) => /^[A-Za-z0-9_-]{43}$/.test(request.nonce)));
  check('OIDC adapter receives stored PKCE verifier', adapter.callbackRequests.every((request) => /^[A-Za-z0-9_-]{43}$/.test(request.codeVerifier)));

  await new Promise<void>((resolveClose) => running?.server.close(() => resolveClose()));
  running = undefined;

  const databaseFiles = readdirSync(stateDir).filter((name) => name === 'partmode.sqlite' || name.startsWith('partmode.sqlite-'));
  for (const filename of databaseFiles) {
    const contents = readFileSync(resolve(stateDir, filename));
    for (const canary of ['new-google-code', 'repeat-google-code', newFlow.state, newFlow.nonce, newFlow.bindingCookie]) {
      check(`${filename} omits transient OAuth material`, !contents.includes(Buffer.from(canary)));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    flows: {
      state: 'one-use',
      browserBinding: 'required',
      expiry: 'enforced',
      allocationRateLimit: 'enforced',
      concurrentCapacity: 'bounded',
      pkce: 'S256',
      nonce: 'validated-by-adapter',
    },
    identity: {
      emailRequested: false,
      emailMerged: false,
      explicitLink: true,
      crossAccountConflict: 'rejected',
    },
    account: {
      passphraseRegression: true,
      immutableIdAcrossGoogleLogin: true,
      agentKeysPreserved: true,
    },
    storage: { transientOAuthMaterial: 0 },
  }));
} finally {
  if (running) await new Promise<void>((resolveClose) => running?.server.close(() => resolveClose()));
  rmSync(stateDir, { recursive: true, force: true });
}
