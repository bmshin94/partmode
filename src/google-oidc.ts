import { timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_AUTH_TRANSACTION_TTL_MS = 10 * 60 * 1_000;

const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_TRANSACTIONS = 2_048;

export type GoogleAuthIntent = 'sign-in' | 'link';

export interface GoogleIdentity {
  provider: 'google';
  issuer: typeof GOOGLE_ISSUER;
  subject: string;
  displayName: string | null;
}

export interface GoogleAuthorizationRequest {
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}

export interface GoogleCallbackRequest {
  callbackUrl: URL;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface GoogleOidcAdapter {
  authorizationUrl(request: GoogleAuthorizationRequest): Promise<URL>;
  exchangeCallback(request: GoogleCallbackRequest): Promise<GoogleIdentity>;
}

export interface GoogleAuthServiceOptions {
  clientId?: string;
  clientSecret?: string;
  adapter?: GoogleOidcAdapter;
  now?: () => Date;
  transactionTtlMs?: number;
  maxTransactions?: number;
}

export interface GoogleAuthStart {
  authorizationUrl: URL;
  browserBinding: string;
  expiresAt: string;
}

export interface CompletedGoogleAuth {
  intent: GoogleAuthIntent;
  accountId: string | null;
  identity: GoogleIdentity;
}

export type GoogleAuthErrorCode =
  | 'GOOGLE_AUTH_BUSY'
  | 'GOOGLE_AUTH_CANCELLED'
  | 'GOOGLE_AUTH_FAILED'
  | 'GOOGLE_AUTH_TRANSACTION_EXPIRED'
  | 'GOOGLE_AUTH_TRANSACTION_INVALID';

export class GoogleAuthError extends Error {
  readonly code: GoogleAuthErrorCode;

  constructor(code: GoogleAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoogleAuthError';
    this.code = code;
  }
}

type GoogleAuthTransaction = {
  intent: GoogleAuthIntent;
  accountId: string | null;
  browserBinding: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  expiresAt: number;
};

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().replace(/\s+/gu, ' ');
  if (!normalized) return null;
  return Array.from(normalized).slice(0, 80).join('');
}

function assertCallbackUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Google callback URI must be an absolute URL.');
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !localHttp)) {
    throw new TypeError('Google callback URI must be HTTPS, except on loopback development hosts.');
  }
  return url;
}

function safeEqual(left: string, right: string): boolean {
  if (!OPAQUE_VALUE_PATTERN.test(left) || !OPAQUE_VALUE_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'));
}

class OpenIdClientGoogleAdapter implements GoogleOidcAdapter {
  readonly #clientId: string;
  readonly #clientSecret: string;
  #configuration: Promise<oidc.Configuration> | null = null;

  constructor(clientId: string, clientSecret: string) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
  }

  async authorizationUrl(request: GoogleAuthorizationRequest): Promise<URL> {
    const configuration = await this.#configurationForGoogle();
    return oidc.buildAuthorizationUrl(configuration, {
      client_id: this.#clientId,
      redirect_uri: request.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
  }

  async exchangeCallback(request: GoogleCallbackRequest): Promise<GoogleIdentity> {
    const responseIssuer = request.callbackUrl.searchParams.getAll('iss');
    if (responseIssuer.length !== 1 || responseIssuer[0] !== GOOGLE_ISSUER) {
      throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google returned an invalid authorization issuer.');
    }
    const configuration = await this.#configurationForGoogle();
    const tokens = await oidc.authorizationCodeGrant(
      configuration,
      request.callbackUrl,
      {
        pkceCodeVerifier: request.codeVerifier,
        expectedState: request.state,
        expectedNonce: request.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    const subject = claims?.sub;
    if (
      claims?.iss !== GOOGLE_ISSUER ||
      typeof subject !== 'string' ||
      subject.length < 1 ||
      subject.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(subject)
    ) {
      throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google returned an invalid identity.');
    }
    return {
      provider: 'google',
      issuer: GOOGLE_ISSUER,
      subject,
      displayName: normalizeDisplayName(claims.name),
    };
  }

  #configurationForGoogle(): Promise<oidc.Configuration> {
    this.#configuration ??= oidc.discovery(
      new URL(GOOGLE_ISSUER),
      this.#clientId,
      this.#clientSecret,
      oidc.ClientSecretPost(this.#clientSecret),
      {
        timeout: 5,
        execute: [oidc.enableNonRepudiationChecks],
      },
    ).catch((error: unknown) => {
      this.#configuration = null;
      throw error;
    });
    return this.#configuration;
  }
}

export class GoogleAuthService {
  readonly #adapter: GoogleOidcAdapter;
  readonly #now: () => Date;
  readonly #transactionTtlMs: number;
  readonly #maxTransactions: number;
  readonly #transactions = new Map<string, GoogleAuthTransaction>();

  constructor(options: GoogleAuthServiceOptions) {
    const transactionTtlMs = options.transactionTtlMs ?? GOOGLE_AUTH_TRANSACTION_TTL_MS;
    const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
    if (!Number.isSafeInteger(transactionTtlMs) || transactionTtlMs < 60_000 || transactionTtlMs > 30 * 60 * 1_000) {
      throw new TypeError('Google auth transaction TTL must be from one through thirty minutes.');
    }
    if (!Number.isSafeInteger(maxTransactions) || maxTransactions < 1 || maxTransactions > 100_000) {
      throw new TypeError('Google auth transaction capacity is invalid.');
    }
    if (options.adapter) {
      this.#adapter = options.adapter;
    } else {
      const clientId = options.clientId?.trim();
      const clientSecret = options.clientSecret?.trim();
      if (!clientId || !clientSecret) {
        throw new TypeError('Google auth requires both a client ID and client secret.');
      }
      this.#adapter = new OpenIdClientGoogleAdapter(clientId, clientSecret);
    }
    this.#now = options.now ?? (() => new Date());
    this.#transactionTtlMs = transactionTtlMs;
    this.#maxTransactions = maxTransactions;
  }

  async begin(
    intent: GoogleAuthIntent,
    redirectUriValue: string,
    accountId: string | null = null,
  ): Promise<GoogleAuthStart> {
    if (intent !== 'sign-in' && intent !== 'link') throw new TypeError('Google auth intent is invalid.');
    if (intent === 'link' && (!accountId || typeof accountId !== 'string')) {
      throw new TypeError('Google link transactions require an account ID.');
    }
    if (intent === 'sign-in' && accountId !== null) {
      throw new TypeError('Google sign-in transactions cannot be pre-bound to an account.');
    }
    const redirectUri = assertCallbackUri(redirectUriValue).href;
    const now = this.#timestamp();
    this.#prune(now);
    if (this.#transactions.size >= this.#maxTransactions) {
      throw new GoogleAuthError('GOOGLE_AUTH_BUSY', 'PartMode is handling too many sign-in attempts.');
    }
    let state = oidc.randomState();
    while (this.#transactions.has(state)) state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const browserBinding = oidc.randomState();
    const expiresAt = now + this.#transactionTtlMs;
    this.#transactions.set(state, {
      intent,
      accountId,
      browserBinding,
      codeVerifier,
      nonce,
      redirectUri,
      expiresAt,
    });
    try {
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const authorizationUrl = await this.#adapter.authorizationUrl({
        redirectUri,
        state,
        nonce,
        codeChallenge,
      });
      if (authorizationUrl.protocol !== 'https:') {
        throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google returned an insecure authorization endpoint.');
      }
      return {
        authorizationUrl,
        browserBinding,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch (error) {
      this.#transactions.delete(state);
      throw error;
    }
  }

  async complete(callbackUrl: URL, browserBinding: string): Promise<CompletedGoogleAuth> {
    const stateValues = callbackUrl.searchParams.getAll('state');
    const state = stateValues.length === 1 ? stateValues[0] ?? '' : '';
    const transaction = OPAQUE_VALUE_PATTERN.test(state) ? this.#transactions.get(state) : undefined;
    if (!transaction) {
      throw new GoogleAuthError('GOOGLE_AUTH_TRANSACTION_INVALID', 'The Google sign-in transaction is invalid.');
    }
    this.#transactions.delete(state);
    const now = this.#timestamp();
    this.#prune(now);
    if (transaction.expiresAt <= now) {
      throw new GoogleAuthError('GOOGLE_AUTH_TRANSACTION_EXPIRED', 'The Google sign-in transaction expired.');
    }
    if (!safeEqual(browserBinding, transaction.browserBinding)) {
      throw new GoogleAuthError('GOOGLE_AUTH_TRANSACTION_INVALID', 'The Google sign-in browser binding is invalid.');
    }
    const expectedCallback = new URL(transaction.redirectUri);
    if (
      callbackUrl.origin !== expectedCallback.origin ||
      callbackUrl.pathname !== expectedCallback.pathname ||
      callbackUrl.hash
    ) {
      throw new GoogleAuthError('GOOGLE_AUTH_TRANSACTION_INVALID', 'The Google sign-in callback URI is invalid.');
    }
    const providerErrors = callbackUrl.searchParams.getAll('error');
    if (providerErrors.length > 0) {
      if (providerErrors.length === 1 && providerErrors[0] === 'access_denied') {
        throw new GoogleAuthError('GOOGLE_AUTH_CANCELLED', 'Google sign-in was cancelled.');
      }
      throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google could not complete sign-in.');
    }
    try {
      const identity = await this.#adapter.exchangeCallback({
        callbackUrl,
        redirectUri: transaction.redirectUri,
        state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      if (
        identity.provider !== 'google' ||
        identity.issuer !== GOOGLE_ISSUER ||
        typeof identity.subject !== 'string' ||
        identity.subject.length < 1 ||
        identity.subject.length > 255
      ) {
        throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google returned an invalid identity.');
      }
      return {
        intent: transaction.intent,
        accountId: transaction.accountId,
        identity: {
          ...identity,
          displayName: normalizeDisplayName(identity.displayName),
        },
      };
    } catch (error) {
      if (error instanceof GoogleAuthError) throw error;
      throw new GoogleAuthError('GOOGLE_AUTH_FAILED', 'Google could not complete sign-in.', { cause: error });
    }
  }

  close(): void {
    this.#transactions.clear();
  }

  #prune(now: number): void {
    for (const [state, transaction] of this.#transactions) {
      if (transaction.expiresAt <= now) this.#transactions.delete(state);
    }
  }

  #timestamp(): number {
    const value = this.#now().getTime();
    if (!Number.isSafeInteger(value)) throw new TypeError('Google auth clock returned an invalid date.');
    return value;
  }
}
