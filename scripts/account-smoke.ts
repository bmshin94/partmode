import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  startPartModeServer,
  type RunningPartModeServer,
} from '../src/server.js';

type JsonRecord = Record<string, unknown>;

interface JsonResponse {
  response: Response;
  body: JsonRecord;
  text: string;
}

const REQUIRED_ACCOUNT_IDS = Object.freeze([
  'pm-account-app',
  'pm-auth-view',
  'pm-dashboard',
  'pm-signup-form',
  'pm-login-form',
  'pm-google-auth',
  'pm-google-note',
  'pm-google-signin',
  'pm-google-connection',
  'pm-google-link',
  'pm-google-unlink',
  'pm-account-name',
  'pm-key-form',
  'pm-key-list',
  'pm-key-secret',
  'pm-key-secret-value',
  'pm-key-copy',
  'pm-key-dismiss',
  'pm-logout',
  'pm-delete-account',
  'pm-account-status',
]);

const MCP_INITIALIZE = Object.freeze({
  jsonrpc: '2.0',
  id: 'account-smoke-initialize',
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'PartMode account smoke', version: '1.0.0' },
  },
});

function check(name: string, condition: unknown): asserts condition {
  if (!condition) throw new Error(`Account smoke failed: ${name}`);
}

function record(value: unknown, name: string): JsonRecord {
  check(name, Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  return value as JsonRecord;
}

async function readJsonResponse(response: Response, name: string): Promise<JsonResponse> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Account smoke failed: ${name} did not return JSON`);
  }
  return { response, body: record(value, `${name} returned a JSON object`), text };
}

function cookieFrom(response: Response, name: string): {
  header: string;
  cookie: string;
  cookieName: string;
  token: string;
} {
  const header = response.headers.get('set-cookie') ?? '';
  const cookie = header.split(';', 1)[0] ?? '';
  const separator = cookie.indexOf('=');
  check(`${name} sets a cookie`, separator > 0);
  const cookieName = cookie.slice(0, separator);
  const token = cookie.slice(separator + 1);
  check(`${name} cookie token is opaque`, /^[A-Za-z0-9_-]{43}$/.test(token));
  return { header, cookie, cookieName, token };
}

function originHeaders(
  origin: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Origin: origin,
    'Sec-Fetch-Site': 'same-origin',
    ...extra,
  };
}

function jsonHeaders(
  origin: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return originHeaders(origin, {
    'Content-Type': 'application/json',
    ...extra,
  });
}

async function closeServer(running: RunningPartModeServer): Promise<void> {
  await new Promise<void>((resolveClose) => running.server.close(() => resolveClose()));
}

const stateDir = mkdtempSync(resolve(tmpdir(), 'partmode-account-smoke-'));
const suffix = randomBytes(6).toString('hex');
const accountName = `Account-Smoke-${suffix}`;
const normalizedAccountName = accountName.toLowerCase();
const password = `PartMode account smoke passphrase ${suffix}`;
const deletedAccountName = `delete-${suffix}`;
const deletedPassword = `PartMode deleted account passphrase ${suffix}`;

let running: RunningPartModeServer | undefined;

try {
  running = await startPartModeServer({
    distDir: resolve('dist'),
    host: '127.0.0.1',
    port: 0,
    stateDir,
  });
  const origin = running.url;
  const url = (path: string) => new URL(path, origin).href;

  const accountPage = await fetch(url('/account'));
  const accountHtml = await accountPage.text();
  check('account page returns 200', accountPage.status === 200);
  check('account page is never cached', accountPage.headers.get('cache-control') === 'no-store');
  const csp = accountPage.headers.get('content-security-policy') ?? '';
  check(
    'account page has a restrictive CSP',
    csp.includes("default-src 'none'") &&
      csp.includes("connect-src 'self'") &&
      csp.includes("script-src 'self'") &&
      csp.includes("frame-ancestors 'none'"),
  );
  for (const id of REQUIRED_ACCOUNT_IDS) {
    check(`account page includes #${id}`, accountHtml.includes(`id="${id}"`));
  }
  check(
    'account page links the complete agent workflow',
    accountHtml.includes('href="/help#agents"') && accountHtml.includes('complete agent workflow'),
  );

  const anonymous = await readJsonResponse(
    await fetch(url('/api/v1/account')),
    'anonymous account status',
  );
  check('anonymous account status returns 200', anonymous.response.status === 200);
  check('anonymous account status is unauthenticated', anonymous.body.authenticated === false);
  check('anonymous account status does not set a cookie', !anonymous.response.headers.has('set-cookie'));
  check(
    'anonymous account status reports Google disabled without credentials',
    record(record(anonymous.body.authMethods, 'anonymous auth methods').google, 'anonymous Google method').enabled === false,
  );

  const missingOrigin = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: accountName, password }),
    }),
    'missing-origin signup',
  );
  check(
    'signup rejects a missing Origin',
    missingOrigin.response.status === 403 && missingOrigin.body.error === 'ORIGIN_REJECTED',
  );

  const wrongOrigin = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: originHeaders('https://attacker.invalid', {
        'Content-Type': 'application/json',
        'Sec-Fetch-Site': 'cross-site',
      }),
      body: JSON.stringify({ name: accountName, password }),
    }),
    'cross-origin signup',
  );
  check(
    'signup rejects a different Origin',
    wrongOrigin.response.status === 403 && wrongOrigin.body.error === 'ORIGIN_REJECTED',
  );

  const wrongContentType = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: originHeaders(origin, { 'Content-Type': 'text/plain' }),
      body: JSON.stringify({ name: accountName, password }),
    }),
    'non-JSON signup',
  );
  check(
    'signup requires JSON content type',
    wrongContentType.response.status === 415 && wrongContentType.body.error === 'JSON_REQUIRED',
  );

  const invalidInputs: ReadonlyArray<{
    name: string;
    body: { name: string; password: string };
    code: string;
  }> = [
    {
      name: 'short account name',
      body: { name: 'ab', password },
      code: 'ACCOUNT_NAME_INVALID',
    },
    {
      name: 'long account name',
      body: { name: 'a'.repeat(41), password },
      code: 'ACCOUNT_NAME_INVALID',
    },
    {
      name: 'short passphrase',
      body: { name: `short-${suffix}`, password: 'x'.repeat(11) },
      code: 'PASSWORD_INVALID',
    },
    {
      name: 'long passphrase',
      body: { name: `long-${suffix}`, password: 'x'.repeat(257) },
      code: 'PASSWORD_INVALID',
    },
  ];
  for (const candidate of invalidInputs) {
    const result = await readJsonResponse(
      await fetch(url('/api/v1/accounts'), {
        method: 'POST',
        headers: jsonHeaders(origin),
        body: JSON.stringify(candidate.body),
      }),
      candidate.name,
    );
    check(
      `signup rejects ${candidate.name}`,
      result.response.status === 400 && result.body.error === candidate.code,
    );
  }

  const signup = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({ name: accountName, password }),
    }),
    'valid signup',
  );
  check('valid signup returns 201', signup.response.status === 201);
  check('valid signup authenticates the account', signup.body.authenticated === true);
  const signupAccount = record(signup.body.account, 'valid signup returns an account');
  check('valid signup normalizes the account name', signupAccount.name === normalizedAccountName);
  check('passphrase signup records its local sign-in method', signupAccount.hasPassphrase === true);
  check(
    'valid signup returns a CSRF token',
    typeof signup.body.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(signup.body.csrfToken),
  );
  const csrfToken = signup.body.csrfToken;
  const signupCookie = cookieFrom(signup.response, 'valid signup');
  check('local signup uses the development cookie name', signupCookie.cookieName === 'partmode_account_dev');
  check('session cookie uses Path=/', /(?:^|;\s*)Path=\/(?:;|$)/i.test(signupCookie.header));
  check('session cookie is HttpOnly', /(?:^|;\s*)HttpOnly(?:;|$)/i.test(signupCookie.header));
  check('session cookie is SameSite=Lax', /(?:^|;\s*)SameSite=Lax(?:;|$)/i.test(signupCookie.header));
  check('session cookie has a positive lifetime', /(?:^|;\s*)Max-Age=[1-9][0-9]*(?:;|$)/i.test(signupCookie.header));
  check('loopback HTTP cookie is not marked Secure', !/(?:^|;\s*)Secure(?:;|$)/i.test(signupCookie.header));

  const duplicate = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({ name: accountName, password }),
    }),
    'duplicate signup',
  );
  check(
    'duplicate signup is rejected',
    duplicate.response.status === 409 && duplicate.body.error === 'ACCOUNT_NAME_TAKEN',
  );

  const authenticated = await readJsonResponse(
    await fetch(url('/api/v1/account'), {
      headers: { Cookie: signupCookie.cookie },
    }),
    'authenticated account status',
  );
  check('session cookie authenticates account status', authenticated.body.authenticated === true);
  check('initial account has no keys', Array.isArray(authenticated.body.keys) && authenticated.body.keys.length === 0);

  const csrfFailure = await readJsonResponse(
    await fetch(url('/api/v1/agent-keys'), {
      method: 'POST',
      headers: jsonHeaders(origin, { Cookie: signupCookie.cookie }),
      body: JSON.stringify({ label: 'Account smoke agent', access: 'edit' }),
    }),
    'missing-CSRF key creation',
  );
  check(
    'authenticated mutation rejects missing CSRF',
    csrfFailure.response.status === 403 && csrfFailure.body.error === 'CSRF_REJECTED',
  );

  const createKeyResponse = await fetch(url('/api/v1/agent-keys'), {
    method: 'POST',
    headers: jsonHeaders(origin, {
      Cookie: signupCookie.cookie,
      'X-PartMode-CSRF': csrfToken,
    }),
    body: JSON.stringify({ label: 'Account smoke agent', access: 'edit' }),
  });
  const createKey = await readJsonResponse(createKeyResponse, 'agent key creation');
  check('agent key creation returns 201', createKey.response.status === 201);
  check(
    'agent key creation returns one raw key',
    typeof createKey.body.rawKey === 'string' &&
      /^pmak_v1_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/.test(createKey.body.rawKey),
  );
  const rawKey = createKey.body.rawKey;
  check(
    'raw agent key appears exactly once in the creation response',
    createKey.text.split(rawKey).length - 1 === 1,
  );
  const publicKey = record(createKey.body.key, 'agent key creation returns public metadata');
  check('agent key creation returns a key ID', typeof publicKey.id === 'string' && /^[A-Za-z0-9_-]{12}$/.test(publicKey.id));
  const keyId = publicKey.id;

  const listed = await readJsonResponse(
    await fetch(url('/api/v1/account'), { headers: { Cookie: signupCookie.cookie } }),
    'account key listing',
  );
  check('account key listing remains authenticated', listed.body.authenticated === true);
  check('account key listing contains one key', Array.isArray(listed.body.keys) && listed.body.keys.length === 1);
  check('account key listing omits the raw key', !listed.text.includes(rawKey));
  const listedKey = record((listed.body.keys as unknown[])[0], 'account key listing returns metadata');
  check('account key listing has no rawKey field', !Object.hasOwn(listedKey, 'rawKey'));

  const wrongBearer = `pmak_v1_${'a'.repeat(12)}_${'b'.repeat(43)}`;
  const wrongAgent = await readJsonResponse(
    await fetch(url('/mcp'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wrongBearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(MCP_INITIALIZE),
    }),
    'wrong agent bearer',
  );
  check(
    'wrong agent bearer is rejected',
    wrongAgent.response.status === 401 && wrongAgent.body.error === 'INVALID_AGENT_KEY',
  );

  const validAgent = await readJsonResponse(
    await fetch(url('/mcp'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(MCP_INITIALIZE),
    }),
    'valid agent bearer',
  );
  check('new agent key authenticates MCP', validAgent.response.status === 200 && validAgent.body.jsonrpc === '2.0');

  const revoke = await readJsonResponse(
    await fetch(url(`/api/v1/agent-keys/${encodeURIComponent(keyId)}`), {
      method: 'DELETE',
      headers: jsonHeaders(origin, {
        Cookie: signupCookie.cookie,
        'X-PartMode-CSRF': csrfToken,
      }),
      body: '{}',
    }),
    'agent key revocation',
  );
  check('agent key revocation succeeds', revoke.response.status === 200 && revoke.body.revoked === true);

  const revokedAgent = await readJsonResponse(
    await fetch(url('/mcp'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rawKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(MCP_INITIALIZE),
    }),
    'revoked agent bearer',
  );
  check(
    'revoked agent key is rejected',
    revokedAgent.response.status === 401 && revokedAgent.body.error === 'INVALID_AGENT_KEY',
  );

  const afterRevoke = await readJsonResponse(
    await fetch(url('/api/v1/account'), { headers: { Cookie: signupCookie.cookie } }),
    'revoked key listing',
  );
  check('revoked key listing omits the raw key', !afterRevoke.text.includes(rawKey));
  check('revoked key remains auditable', Array.isArray(afterRevoke.body.keys) && afterRevoke.body.keys.length === 1);
  const revokedPublicKey = record((afterRevoke.body.keys as unknown[])[0], 'revoked key has public metadata');
  check('revoked key records revocation time', typeof revokedPublicKey.revokedAt === 'string');

  const logout = await readJsonResponse(
    await fetch(url('/api/v1/session'), {
      method: 'DELETE',
      headers: jsonHeaders(origin, {
        Cookie: signupCookie.cookie,
        'X-PartMode-CSRF': csrfToken,
      }),
      body: '{}',
    }),
    'account logout',
  );
  check('logout succeeds', logout.response.status === 200 && logout.body.authenticated === false);
  check('logout clears the session cookie', /Max-Age=0/i.test(logout.response.headers.get('set-cookie') ?? ''));

  const oldSession = await readJsonResponse(
    await fetch(url('/api/v1/account'), { headers: { Cookie: signupCookie.cookie } }),
    'old session after logout',
  );
  check('logged-out session no longer authenticates', oldSession.body.authenticated === false);

  const login = await readJsonResponse(
    await fetch(url('/api/v1/session'), {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({ name: accountName, password }),
    }),
    'account login',
  );
  check('existing account can sign in', login.response.status === 200 && login.body.authenticated === true);
  check(
    'login returns a CSRF token',
    typeof login.body.csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(login.body.csrfToken),
  );
  const primaryLoginCookie = cookieFrom(login.response, 'account login');

  const deletedSignup = await readJsonResponse(
    await fetch(url('/api/v1/accounts'), {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({ name: deletedAccountName, password: deletedPassword }),
    }),
    'deletable account signup',
  );
  check('deletable account signup succeeds', deletedSignup.response.status === 201);
  check('deletable account has a CSRF token', typeof deletedSignup.body.csrfToken === 'string');
  const deletedCookie = cookieFrom(deletedSignup.response, 'deletable account signup');

  const accountDelete = await readJsonResponse(
    await fetch(url('/api/v1/account'), {
      method: 'DELETE',
      headers: jsonHeaders(origin, {
        Cookie: deletedCookie.cookie,
        'X-PartMode-CSRF': deletedSignup.body.csrfToken as string,
      }),
      body: '{}',
    }),
    'account deletion',
  );
  check(
    'account deletion succeeds',
    accountDelete.response.status === 200 &&
      accountDelete.body.deleted === true &&
      accountDelete.body.authenticated === false,
  );
  check('account deletion clears its cookie', /Max-Age=0/i.test(accountDelete.response.headers.get('set-cookie') ?? ''));

  const deletedLogin = await readJsonResponse(
    await fetch(url('/api/v1/session'), {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({ name: deletedAccountName, password: deletedPassword }),
    }),
    'deleted account login',
  );
  check(
    'deleted account cannot sign in',
    deletedLogin.response.status === 401 && deletedLogin.body.error === 'INVALID_CREDENTIALS',
  );

  const primaryStillActive = await readJsonResponse(
    await fetch(url('/api/v1/account'), { headers: { Cookie: primaryLoginCookie.cookie } }),
    'primary account after other account deletion',
  );
  check('deleting one account preserves another session', primaryStillActive.body.authenticated === true);

  await closeServer(running);
  running = undefined;

  const databaseFiles = readdirSync(stateDir)
    .filter((name) => name === 'partmode.sqlite' || name.startsWith('partmode.sqlite-'))
    .sort();
  check('SQLite database exists', databaseFiles.includes('partmode.sqlite'));
  const secretCanaries = [
    password,
    deletedPassword,
    signupCookie.token,
    primaryLoginCookie.token,
    deletedCookie.token,
    rawKey,
  ];
  for (const filename of databaseFiles) {
    const content = readFileSync(resolve(stateDir, filename));
    for (const canary of secretCanaries) {
      check(`${filename} omits raw credentials`, !content.includes(Buffer.from(canary, 'utf8')));
    }
  }

  console.log(JSON.stringify({
    ok: true,
    accountPage: { csp: true, requiredIds: REQUIRED_ACCOUNT_IDS.length },
    signup: { origin: 'enforced', json: 'enforced', bounds: 'enforced', duplicate: 'rejected' },
    session: { cookie: 'scoped', csrf: 'enforced', logout: 'revoked' },
    agentKey: { oneTimeSecret: true, listingRedacted: true, revokedBearerRejected: true },
    accountDeletion: true,
    storage: { filesScanned: databaseFiles.length, rawCredentials: 0 },
  }));
} finally {
  if (running) await closeServer(running);
  rmSync(stateDir, { recursive: true, force: true });
}
