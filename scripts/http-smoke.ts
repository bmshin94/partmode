import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolvePartModeHelpTokens } from '../src/help.js';
import { startPartModeServer } from '../src/server.js';
import { PARTMODE_UX_NAVIGATION_CONTRACT } from '../src/ux-navigation-contract.js';

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'partmode-http-'));
const running = await startPartModeServer({
  distDir: resolve('dist'),
  host: '127.0.0.1',
  port: 0,
  stateDir: resolve(temporaryDirectory, 'state'),
});

function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`HTTP smoke failed: ${name}`);
}

let unknownHelpPathRejected = false;
try {
  resolvePartModeHelpTokens('contract-smoke.md', '{{ux-path:not-a-real-path}}');
} catch (error) {
  unknownHelpPathRejected = error instanceof Error
    && error.message.includes('unknown PartMode UX navigation path');
}
check('unknown Help navigation paths fail closed', unknownHelpPathRejected);

try {
  const page = await fetch(`${running.url}/`);
  const pageHtml = await page.text();
  check('root returns HTML', page.status === 200 && page.headers.get('content-type')?.startsWith('text/html') === true);
  check('HTML revalidates immediately', page.headers.get('cache-control') === 'public, max-age=0, must-revalidate');
  check('root stays canonical', pageHtml.includes('<link rel="canonical" href="https://partmode.com/"'));
  check('root includes privacy notice', pageHtml.includes('id="pm-cookie-banner"'));
  check('root offers essential-only cookie choice', pageHtml.includes('data-cookie-essential'));
  check(
    'root exposes clear account authentication',
    pageHtml.includes('id="pm-agent-access"') &&
      pageHtml.includes('href="/account"') &&
      pageHtml.includes('>Sign in</span>'),
  );
  check(
    'in-app Help links both audiences to the canonical manual',
    pageHtml.includes('id="bw-help-full"') &&
      pageHtml.includes('id="bw-help-about"') &&
      pageHtml.includes('href="/about"') &&
      pageHtml.includes('id="bw-help-agent-guide"') &&
      pageHtml.includes('href="/help#agents"'),
  );

  const helpRedirect = await fetch(`${running.url}/help/`, { redirect: 'manual' });
  check(
    'help slash redirects canonically',
    helpRedirect.status === 308 && helpRedirect.headers.get('location') === '/help',
  );
  const help = await fetch(`${running.url}/help`);
  const helpHtml = await help.text();
  check(
    'release-versioned human Help is live',
    help.status === 200 &&
      help.headers.get('cache-control') === 'public, max-age=0, must-revalidate' &&
      helpHtml.includes('<title>Help | PartMode</title>') &&
      helpHtml.includes(`content="${running.release.releaseSha}"`) &&
      helpHtml.includes('PartMode is free to use and is intended to remain free') &&
      helpHtml.includes('>Sphinx</a>') &&
      helpHtml.includes('href="/about"') &&
      helpHtml.includes('partmode://help/agent-workflow'),
  );
  const aboutRedirect = await fetch(`${running.url}/about/`, { redirect: 'manual' });
  check(
    'about slash redirects canonically',
    aboutRedirect.status === 308 && aboutRedirect.headers.get('location') === '/about',
  );
  const about = await fetch(`${running.url}/about`);
  const aboutHtml = await about.text();
  check(
    'public About page is live without private creator identity',
    about.status === 200 &&
      about.headers.get('cache-control') === 'public, max-age=0, must-revalidate' &&
      aboutHtml.includes('<title>About | PartMode</title>') &&
      aboutHtml.includes('<link rel="canonical" href="https://partmode.com/about"') &&
      aboutHtml.includes(`content="${running.release.releaseSha}"`) &&
      aboutHtml.includes('PartMode is free to use and is intended to remain free') &&
      aboutHtml.includes('<a href="https://x.com/protosphinx" rel="me noopener">Sphinx</a>') &&
      !/(?:founder|>\s*@protosphinx\s*<)/iu.test(aboutHtml),
  );
  const helpApi = await fetch(`${running.url}/api/v1/help`);
  const helpApiBody = await helpApi.json() as {
    schema?: string;
    releaseSha?: string;
    navigation?: unknown;
    resources?: Array<{ uri?: string; text?: string }>;
  };
  const expectedTurbofanPath = PARTMODE_UX_NAVIGATION_CONTRACT.paths.find(
    (path) => path.id === 'templates.exploded-turbofan.existing-editor',
  );
  check(
    'machine-readable Help matches the exact release',
    helpApi.status === 200 &&
      helpApi.headers.get('cache-control') === 'no-store' &&
      helpApiBody.schema === 'partmode.help/v1' &&
      helpApiBody.releaseSha === running.release.releaseSha &&
      JSON.stringify(helpApiBody.navigation) === JSON.stringify(PARTMODE_UX_NAVIGATION_CONTRACT) &&
      expectedTurbofanPath?.userPath ===
        'Home → Template library → Exploded turbofan assembly → Open editable template' &&
      helpApiBody.resources?.length === 4 &&
      helpApiBody.resources.some((resource) =>
        resource.uri === 'partmode://help/agent-workflow' && resource.text?.includes('cad_capabilities')) === true,
  );

  const asset = await fetch(
    `${running.url}/assets/${running.release.assetVersion}/studio.js`,
    { method: 'HEAD' },
  );
  check('versioned Studio asset exists', asset.status === 200);
  check('versioned assets are immutable', asset.headers.get('cache-control') === 'public, max-age=31536000, immutable');
  check('HEAD has no response body', (await asset.text()).length === 0);

  const privacyRedirect = await fetch(`${running.url}/privacy/`, { redirect: 'manual' });
  check(
    'privacy slash redirects canonically',
    privacyRedirect.status === 308 && privacyRedirect.headers.get('location') === '/privacy',
  );
  const privacy = await fetch(`${running.url}/privacy`);
  check('privacy surface is live', privacy.status === 200 && (await privacy.text()).includes('<h1>Privacy</h1>'));
  const cookiesRedirect = await fetch(`${running.url}/cookies/`, { redirect: 'manual' });
  check(
    'cookies slash redirects canonically',
    cookiesRedirect.status === 308 && cookiesRedirect.headers.get('location') === '/cookies',
  );
  const cookies = await fetch(`${running.url}/cookies`);
  const cookiesHtml = await cookies.text();
  check(
    'cookie settings surface is live',
    cookies.status === 200 &&
      cookiesHtml.includes('<h1>Cookie details and settings</h1>') &&
      cookiesHtml.includes('partmode_cookie_consent'),
  );
  check('cookie settings inventories signed-in session', cookiesHtml.includes('__Host-partmode_account'));

  const accountRedirect = await fetch(`${running.url}/account/`, { redirect: 'manual' });
  check(
    'account slash redirects canonically',
    accountRedirect.status === 308 && accountRedirect.headers.get('location') === '/account',
  );
  const account = await fetch(`${running.url}/account`);
  const accountHtml = await account.text();
  check(
    'signed-out agent access surface is live',
    account.status === 200 &&
      account.headers.get('cache-control') === 'no-store' &&
      account.headers.get('content-security-policy')?.includes("default-src 'none'") === true &&
      accountHtml.includes('id="pm-signup-form"') &&
      accountHtml.includes('id="pm-google-signin"') &&
      accountHtml.includes('https://partmode.com/mcp'),
  );

  const accountState = await fetch(`${running.url}/api/v1/account`);
  check(
    'anonymous account state creates no session',
    accountState.status === 200 &&
      (await accountState.json() as { authenticated?: boolean }).authenticated === false &&
      accountState.headers.get('set-cookie') === null,
  );

  const unauthenticatedMcp = await fetch(`${running.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
  });
  check(
    'hosted MCP rejects missing agent key',
    unauthenticatedMcp.status === 401 && unauthenticatedMcp.headers.get('www-authenticate')?.includes('Bearer') === true,
  );

  const health = await fetch(`${running.url}/healthz`);
  const healthBody = await health.json() as {
    ok?: boolean;
    product?: string;
    sha?: string;
    authentication?: { googleConfigured?: boolean };
    help?: { schema?: string; sourceSha256?: string; resources?: number };
  };
  check('health reports PartMode identity', health.status === 200 && healthBody.ok === true && healthBody.product === 'PartMode');
  check('health records release SHA', healthBody.sha === running.release.releaseSha);
  check('health reports Google configuration state', healthBody.authentication?.googleConfigured === false);
  check(
    'health binds the deployed Help corpus',
    healthBody.help?.schema === 'partmode.help/v1' &&
      /^[0-9a-f]{64}$/.test(healthBody.help?.sourceSha256 ?? '') &&
      healthBody.help?.resources === 4,
  );
  check('health is never cached', health.headers.get('cache-control') === 'no-store');

  const sitemap = await fetch(`${running.url}/sitemap.xml`);
  const sitemapXml = await sitemap.text();
  check(
    'sitemap publishes canonical Help and About pages',
    sitemap.status === 200 &&
      sitemapXml.includes('https://partmode.com/help') &&
      sitemapXml.includes('https://partmode.com/about'),
  );

  const legacyAsset = await fetch(`${running.url}/static/studio.js`);
  check('legacy static namespace is not served', legacyAsset.status === 404);
  const post = await fetch(`${running.url}/`, { method: 'POST' });
  check('server is read-only', post.status === 405 && post.headers.get('allow') === 'GET, HEAD');

  console.log(
    JSON.stringify({
      ok: true,
      releaseSha: running.release.releaseSha,
      assetVersion: running.release.assetVersion,
      htmlCache: page.headers.get('cache-control'),
      assetCache: asset.headers.get('cache-control'),
    }),
  );
} finally {
  await new Promise<void>((resolveClose) => running.server.close(() => resolveClose()));
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
