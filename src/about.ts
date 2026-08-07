interface PartModeAboutPageOptions {
  assetVersion: string;
  releaseSha: string;
  version: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function renderPartModeAboutHtml(options: PartModeAboutPageOptions): string {
  const assetVersion = escapeHtml(options.assetVersion);
  const releaseSha = escapeHtml(options.releaseSha);
  const version = escapeHtml(options.version);
  const shortSha = options.releaseSha === 'local' ? 'local' : escapeHtml(options.releaseSha.slice(0, 12));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="About PartMode, its free-use commitment, local-first CAD approach, and public creator identity." />
    <meta name="partmode-release" content="${releaseSha}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="About | PartMode" />
    <meta property="og:description" content="PartMode is free-to-use, local-first browser CAD for people and typed agents." />
    <meta property="og:url" content="https://partmode.com/about" />
    <title>About | PartMode</title>
    <link rel="canonical" href="https://partmode.com/about" />
    <link rel="icon" href="/assets/${assetVersion}/partmode-mark.svg" type="image/svg+xml" />
    <style>
      :root { color-scheme:dark; --ink:#0b1118; --panel:#121d28; --line:#38506a; --muted:#93a5b7; --text:#e8eef5; --paper:#dbe7f2; --blue:#79bfff; --amber:#efb65f; font:16px/1.65 Inter,ui-sans-serif,system-ui,sans-serif; background:var(--ink); color:var(--text); }
      * { box-sizing:border-box; }
      body { margin:0; background:linear-gradient(90deg,transparent 49.9%,rgba(121,191,255,.035) 50%,transparent 50.1%),var(--ink); }
      a { color:var(--blue); }
      a:focus-visible { outline:2px solid var(--amber); outline-offset:4px; }
      .skip { position:absolute; left:16px; top:-80px; z-index:10; padding:10px 14px; background:var(--paper); color:var(--ink); }
      .skip:focus { top:16px; }
      header { border-bottom:1px solid var(--line); background:linear-gradient(135deg,#121e2a 0%,#0b1118 72%); }
      .pm-about-head,.pm-about-main,.pm-about-foot { width:min(1100px,calc(100% - 40px)); margin:0 auto; }
      .pm-about-head { padding:26px 0 54px; }
      .pm-about-topline { display:flex; align-items:center; justify-content:space-between; gap:20px; color:var(--muted); font:700 12px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.08em; text-transform:uppercase; }
      .pm-about-topline a { color:var(--text); text-decoration:none; }
      .pm-about-nav { display:flex; gap:18px; align-items:center; }
      .pm-about-nav a { color:var(--muted); }
      h1,h2 { font-family:"Arial Narrow","Bahnschrift Condensed",Impact,sans-serif; font-stretch:condensed; line-height:1.02; letter-spacing:.015em; }
      h1 { max-width:840px; margin:64px 0 20px; font-size:clamp(3.5rem,9vw,7.4rem); font-weight:700; }
      .pm-about-lede { max-width:760px; margin:0; color:#bdcbd8; font-size:clamp(1.08rem,2vw,1.35rem); }
      .pm-about-axis { display:grid; grid-template-columns:auto 1fr auto 1fr auto; align-items:center; gap:14px; margin-top:52px; color:var(--paper); font:700 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.1em; }
      .pm-about-axis i { height:1px; background:linear-gradient(90deg,var(--blue),var(--line),var(--amber)); }
      .pm-about-main { padding:34px 0 96px; }
      .pm-about-section { display:grid; grid-template-columns:190px minmax(0,1fr); gap:40px; padding:42px 0 48px; border-bottom:1px solid var(--line); }
      .pm-about-section:last-child { border-bottom:0; }
      .pm-about-label { margin:7px 0 0; color:var(--muted); font:700 11px/1 ui-monospace,SFMono-Regular,Consolas,monospace; letter-spacing:.11em; text-transform:uppercase; }
      .pm-about-section h2 { margin:0 0 16px; color:var(--paper); font-size:clamp(2.1rem,5vw,4rem); }
      .pm-about-copy { max-width:760px; }
      .pm-about-copy p { margin:0 0 15px; }
      .pm-about-copy p:last-child { margin-bottom:0; }
      .pm-about-actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:28px; }
      .pm-about-actions a { min-height:42px; display:inline-flex; align-items:center; padding:8px 14px; border:1px solid var(--line); color:var(--text); text-decoration:none; font-weight:700; }
      .pm-about-actions a:first-child { border-color:var(--blue); background:#13263a; }
      footer { border-top:1px solid var(--line); color:var(--muted); }
      .pm-about-foot { display:flex; justify-content:space-between; gap:20px; padding:24px 0 40px; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
      .pm-about-foot nav { display:flex; gap:16px; flex-wrap:wrap; }
      @media (max-width:700px) { .pm-about-topline,.pm-about-foot { align-items:flex-start; flex-direction:column; } .pm-about-axis { grid-template-columns:1fr; gap:9px; } .pm-about-axis i { display:none; } .pm-about-section { grid-template-columns:1fr; gap:16px; } h1 { margin-top:46px; } }
    </style>
  </head>
  <body>
    <a class="skip" href="#about-content">Skip to About</a>
    <header>
      <div class="pm-about-head">
        <div class="pm-about-topline"><a href="/">PM / PartMode</a><nav class="pm-about-nav" aria-label="PartMode pages"><a href="/help">Help</a><span>ABOUT / V${version}</span></nav></div>
        <h1>The model stays in view.</h1>
        <p class="pm-about-lede">PartMode is browser CAD for people and agents working on the same exact, editable model.</p>
        <div class="pm-about-axis" aria-label="PartMode connects local projects, parametric models, and typed agents"><span>LOCAL PROJECT</span><i></i><span>PARAMETRIC MODEL</span><i></i><span>TYPED AGENT</span></div>
      </div>
    </header>
    <main class="pm-about-main" id="about-content">
      <section class="pm-about-section">
        <p class="pm-about-label">What it is</p>
        <div class="pm-about-copy"><h2>A practical CAD workbench</h2><p>Build parametric parts and structured assemblies in the browser, inspect the exact document, and export normal engineering files. Local CAD needs no account. Agent access is explicit and scoped.</p></div>
      </section>
      <section class="pm-about-section">
        <p class="pm-about-label">Access</p>
        <div class="pm-about-copy"><h2>Free, by intent</h2><p>Yes. PartMode is free to use and is intended to remain free. Its source is available under the repository license.</p></div>
      </section>
      <section class="pm-about-section">
        <p class="pm-about-label">Maker</p>
        <div class="pm-about-copy"><h2>About Sphinx</h2><p>PartMode is made by <a href="https://x.com/protosphinx" rel="me noopener">Sphinx</a>. Sphinx's interests include software, manufacturing, and how practical knowledge becomes repeatable work.</p></div>
      </section>
      <section class="pm-about-section">
        <p class="pm-about-label">Foundation</p>
        <div class="pm-about-copy"><h2>Industrial geometry, local control</h2><p>PartMode uses OpenCascade compiled to WebAssembly, with replicad and three.js. Browser projects, geometry, and recovery history stay on the device unless you explicitly choose a server-headless agent project.</p><div class="pm-about-actions"><a href="/">Open PartMode</a><a href="/help">Read Help</a><a href="https://github.com/BOMWiki/partmode">Source</a><a href="/privacy">Privacy</a></div></div>
      </section>
    </main>
    <footer><div class="pm-about-foot"><span>PartMode ${version} · release ${shortSha}</span><nav aria-label="Footer"><a href="/help">Help</a><a href="/privacy">Privacy</a><a href="/cookies">Cookies</a></nav></div></footer>
  </body>
</html>\n`;
}
