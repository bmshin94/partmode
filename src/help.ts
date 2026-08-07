import { createHash } from 'node:crypto';
import {
  PARTMODE_UX_NAVIGATION_CONTRACT,
  renderPartModeUxNavigationPath,
  type PartModeUxNavigationContract,
} from './ux-navigation-contract.js';

export interface PartModeHelpResource {
  uri: string;
  slug: string;
  name: string;
  title: string;
  description: string;
  audience: readonly ('human' | 'agent')[];
  mimeType: 'text/markdown';
  text: string;
}

export interface PartModeHelpManifest {
  schema: 'partmode.help/v1';
  product: 'PartMode';
  version: string;
  releaseSha: string;
  sourceSha256: string;
  humanUrl: 'https://partmode.com/help';
  machineUrl: 'https://partmode.com/api/v1/help';
  navigation: PartModeUxNavigationContract;
  resources: PartModeHelpResource[];
}

interface HelpSourceDefinition {
  uri: string;
  slug: string;
  sourcePath: string;
  name: string;
  title: string;
  description: string;
  audience: readonly ('human' | 'agent')[];
}

export const PARTMODE_HELP_SOURCES: readonly HelpSourceDefinition[] = Object.freeze([
  {
    uri: 'partmode://help/getting-started',
    slug: 'getting-started',
    sourcePath: 'docs/help/getting-started.md',
    name: 'getting-started',
    title: 'Getting started',
    description: 'Start a local part, use an editable template, and save exact CAD work.',
    audience: ['human', 'agent'],
  },
  {
    uri: 'partmode://help/configurations-and-drawings',
    slug: 'configurations-and-drawings',
    sourcePath: 'docs/help/configurations-and-drawings.md',
    name: 'configurations-and-drawings',
    title: 'Configurations and drawings',
    description: 'Switch part configurations and export the matching STEP, STL, AMF, 3MF, or SVG artifact.',
    audience: ['human', 'agent'],
  },
  {
    uri: 'partmode://help/agent-workflow',
    slug: 'agents',
    sourcePath: 'docs/help/agents.md',
    name: 'agent-workflow',
    title: 'Agent workflow',
    description: 'Choose browser-approved local CAD or an explicitly granted durable headless project, then inspect capabilities, preview, and commit.',
    audience: ['agent', 'human'],
  },
  {
    uri: 'partmode://help/limits-and-safety',
    slug: 'limits-and-safety',
    sourcePath: 'docs/help/limits-and-safety.md',
    name: 'limits-and-safety',
    title: 'Limits, evidence, and safety',
    description: 'Know which results are exact, which are presentation aids, and where engineering review remains required.',
    audience: ['human', 'agent'],
  },
]);

const UX_PATH_TOKEN = /\{\{ux-path:([a-z0-9][a-z0-9.-]*)\}\}/g;

export function resolvePartModeHelpTokens(sourcePath: string, source: string): string {
  let resolved: string;
  try {
    resolved = source.replace(UX_PATH_TOKEN, (_token, pathId: string) =>
      renderPartModeUxNavigationPath(pathId));
  } catch (error) {
    throw new Error(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolved.includes('{{') || resolved.includes('}}')) {
    const token = /\{\{[^\r\n]*?(?:\}\}|$)/.exec(resolved)?.[0] ?? 'unexpanded token';
    throw new Error(`${sourcePath}: unknown or unexpanded Help token ${JSON.stringify(token)}`);
  }
  return resolved;
}

export function buildPartModeHelpManifest(options: {
  version: string;
  releaseSha: string;
  readSource: (sourcePath: string) => string;
}): PartModeHelpManifest {
  const hash = createHash('sha256');
  hash.update(PARTMODE_UX_NAVIGATION_CONTRACT.schema);
  hash.update('\0');
  hash.update(JSON.stringify(PARTMODE_UX_NAVIGATION_CONTRACT.paths));
  hash.update('\0');
  const resources = PARTMODE_HELP_SOURCES.map((definition) => {
    const source = options.readSource(definition.sourcePath).replaceAll('\r\n', '\n');
    const text = resolvePartModeHelpTokens(definition.sourcePath, source).trimEnd() + '\n';
    hash.update(definition.uri);
    hash.update('\0');
    hash.update(text);
    hash.update('\0');
    return {
      uri: definition.uri,
      slug: definition.slug,
      name: definition.name,
      title: definition.title,
      description: definition.description,
      audience: [...definition.audience],
      mimeType: 'text/markdown' as const,
      text,
    };
  });
  return {
    schema: 'partmode.help/v1',
    product: 'PartMode',
    version: options.version,
    releaseSha: options.releaseSha,
    sourceSha256: hash.digest('hex'),
    humanUrl: 'https://partmode.com/help',
    machineUrl: 'https://partmode.com/api/v1/help',
    navigation: PARTMODE_UX_NAVIGATION_CONTRACT,
    resources,
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function markdownToHtml(markdown: string): string {
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let listItem: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushListItem = () => {
    if (!listItem.length) return;
    output.push(`<li>${inlineMarkdown(listItem.join(' '))}</li>`);
    listItem = [];
  };
  const closeList = () => {
    if (!list) return;
    flushListItem();
    output.push(`</${list}>`);
    list = null;
  };

  for (const rawLine of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (code) {
      if (line.startsWith('```')) {
        output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code.push(rawLine);
      }
      continue;
    }
    if (line.startsWith('```')) {
      flushParagraph();
      closeList();
      code = [];
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(4, heading[1]!.length + 1);
      output.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      continue;
    }
    const unordered = /^-\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const nextList: 'ul' | 'ol' = ordered ? 'ol' : 'ul';
      if (list !== nextList) {
        closeList();
        list = nextList;
        output.push(`<${list}>`);
      } else {
        flushListItem();
      }
      listItem.push((unordered ?? ordered)![1]!);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    if (list) listItem.push(line.trim());
    else paragraph.push(line.trim());
  }
  if (code) output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushParagraph();
  closeList();
  return output.join('\n');
}

export function renderPartModeHelpHtml(
  manifest: PartModeHelpManifest,
  options: { assetVersion: string },
): string {
  const navigation = manifest.resources.map((resource) =>
    `<a href="#${escapeHtml(resource.slug)}"><span>${escapeHtml(resource.audience.join(' + '))}</span>${escapeHtml(resource.title)}</a>`).join('');
  const articles = manifest.resources.map((resource) =>
    `<article id="${escapeHtml(resource.slug)}" data-audience="${escapeHtml(resource.audience.join(' '))}">`
    + `<div class="pm-help-topic-meta"><span>${escapeHtml(resource.uri)}</span><span>${escapeHtml(resource.audience.join(' + '))}</span></div>`
    + markdownToHtml(resource.text)
    + '</article>').join('');
  const shortSha = manifest.releaseSha === 'local' ? 'local' : manifest.releaseSha.slice(0, 12);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="PartMode help for people and CAD agents: modeling, configurations, drawings, exact evidence, and approved agent workflows." />
    <meta name="partmode-release" content="${escapeHtml(manifest.releaseSha)}" />
    <title>Help | PartMode</title>
    <link rel="canonical" href="${escapeHtml(manifest.humanUrl)}" />
    <link rel="icon" href="/assets/${escapeHtml(options.assetVersion)}/partmode-mark.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme: dark; --ink:#0b1118; --panel:#121d28; --panel2:#172534; --line:#38506a; --muted:#93a5b7; --text:#e8eef5; --blue:#79bfff; --amber:#efb65f; --paper:#dbe7f2; font:16px/1.62 Inter,ui-sans-serif,system-ui,sans-serif; background:var(--ink); color:var(--text); }
      * { box-sizing:border-box; }
      html { scroll-behavior:smooth; }
      body { margin:0; background:linear-gradient(90deg,transparent 49.9%,rgba(121,191,255,.035) 50%,transparent 50.1%),var(--ink); }
      a { color:var(--blue); }
      a:focus-visible { outline:2px solid var(--amber); outline-offset:4px; }
      .skip { position:absolute; left:16px; top:-80px; z-index:10; padding:10px 14px; background:var(--paper); color:var(--ink); }
      .skip:focus { top:16px; }
      header { border-bottom:1px solid var(--line); background:linear-gradient(135deg,#121e2a 0%,#0b1118 72%); }
      .pm-help-head { width:min(1240px,calc(100% - 40px)); margin:0 auto; padding:26px 0 52px; }
      .pm-help-topline { display:flex; align-items:center; justify-content:space-between; gap:16px; font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
      .pm-help-topline a { color:var(--text); text-decoration:none; }
      .pm-help-meta { display:flex; align-items:center; gap:18px; }
      .pm-help-meta a { color:var(--blue); }
      h1,h2,h3,h4 { font-family:"Arial Narrow","Bahnschrift Condensed",Impact,sans-serif; font-stretch:condensed; line-height:1.02; letter-spacing:.015em; }
      h1 { max-width:880px; margin:58px 0 20px; font-size:clamp(3rem,8vw,6.7rem); font-weight:700; }
      .pm-help-lede { max-width:720px; margin:0; color:#bdcbd8; font-size:clamp(1.05rem,2vw,1.3rem); }
      .pm-help-rail { display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:14px; margin-top:46px; font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.12em; color:var(--paper); }
      .pm-help-rail i { display:block; height:1px; background:linear-gradient(90deg,var(--blue),var(--line) 50%,var(--amber)); position:relative; }
      .pm-help-rail i::after { content:"SAME MODEL / SAME REVISION / SAME EVIDENCE"; position:absolute; left:50%; top:-8px; transform:translateX(-50%); padding:2px 10px; white-space:nowrap; background:#0e1720; color:var(--muted); font-size:10px; font-style:normal; }
      .pm-help-shell { width:min(1240px,calc(100% - 40px)); margin:0 auto; display:grid; grid-template-columns:260px minmax(0,1fr); gap:64px; padding:46px 0 100px; }
      nav { position:sticky; top:24px; align-self:start; border:1px solid var(--line); background:rgba(18,29,40,.92); }
      nav p { margin:0; padding:13px 15px; border-bottom:1px solid var(--line); color:var(--muted); font:700 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.1em; }
      nav a { display:grid; gap:5px; padding:14px 15px; border-bottom:1px solid rgba(56,80,106,.6); color:var(--text); text-decoration:none; font-weight:700; }
      nav a:last-child { border-bottom:0; }
      nav a:hover { background:var(--panel2); }
      nav a span { color:var(--muted); font:700 9px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.1em; text-transform:uppercase; }
      main { min-width:0; }
      article { scroll-margin-top:24px; padding:0 0 58px; margin:0 0 58px; border-bottom:1px solid var(--line); }
      article:last-child { border-bottom:0; }
      .pm-help-topic-meta { display:flex; justify-content:space-between; gap:20px; margin-bottom:18px; color:var(--muted); font:700 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.06em; text-transform:uppercase; }
      article h2 { margin:0 0 20px; font-size:clamp(2.4rem,5vw,4.3rem); }
      article h3 { margin:34px 0 12px; font-size:1.75rem; color:var(--paper); }
      article h4 { margin:26px 0 10px; font-size:1.3rem; color:var(--paper); }
      article p, article li { max-width:820px; }
      article ul, article ol { padding-left:24px; }
      article li { margin:8px 0; }
      article code { color:#b8dcff; background:#0b141d; border:1px solid #25384b; border-radius:3px; padding:.1em .35em; font:500 .88em/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
      article pre { max-width:900px; overflow:auto; padding:18px; border:1px solid var(--line); border-left:3px solid var(--amber); background:#081019; }
      article pre code { padding:0; border:0; background:none; color:#d7e7f5; }
      footer { border-top:1px solid var(--line); color:var(--muted); }
      footer div { width:min(1240px,calc(100% - 40px)); margin:0 auto; padding:24px 0 40px; display:flex; justify-content:space-between; gap:20px; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .pm-help-footer-links { display:flex; justify-content:flex-end; gap:14px; flex-wrap:wrap; }
      @media (max-width:780px) { .pm-help-shell { grid-template-columns:1fr; gap:34px; } nav { position:static; } h1 { margin-top:44px; } .pm-help-rail i::after { display:none; } .pm-help-topline,.pm-help-topic-meta,footer div { align-items:flex-start; flex-direction:column; } .pm-help-footer-links { justify-content:flex-start; } }
      @media (prefers-reduced-motion:reduce) { html { scroll-behavior:auto; } }
    </style>
  </head>
  <body>
    <a class="skip" href="#help-content">Skip to Help</a>
    <header>
      <div class="pm-help-head">
        <div class="pm-help-topline"><a href="/">PM / PartMode</a><span class="pm-help-meta"><a href="/about">ABOUT</a><span>HELP ${escapeHtml(manifest.schema)} · ${escapeHtml(shortSha)}</span></span></div>
        <h1>One model.<br />Two operators.</h1>
        <p class="pm-help-lede">A practical manual for people building locally in the browser and agents using either visible browser approval or an explicitly granted server-headless project.</p>
        <div class="pm-help-rail" aria-label="Human and agent workflows share one model"><span>HUMAN</span><i></i><span>AGENT</span></div>
      </div>
    </header>
    <div class="pm-help-shell">
      <nav aria-label="Help topics"><p>TOPIC REGISTER</p>${navigation}</nav>
      <main id="help-content">${articles}</main>
    </div>
    <footer><div><span>PartMode ${escapeHtml(manifest.version)} · release ${escapeHtml(shortSha)} · made by <a href="https://x.com/protosphinx" rel="me noopener">Sphinx</a></span><span class="pm-help-footer-links"><a href="/">Open PartMode</a><a href="/about">About</a><a href="/account">Agent access</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a><a href="/api/v1/help">Help API</a></span></div></footer>
  </body>
</html>\n`;
}
