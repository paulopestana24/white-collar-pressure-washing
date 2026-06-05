// Full-page screenshot via headless Chrome + the built-in CDP (no puppeteer needed).
// Usage:
//   node screenshot.mjs http://localhost:3000           -> desktop (1440 wide)
//   node screenshot.mjs http://localhost:3000 label     -> desktop, filename suffix
//   node screenshot.mjs http://localhost:3000 mobile    -> mobile (390 wide)
//   node screenshot.mjs http://localhost:3000 hero --mobile
// Saved auto-incremented to "./temporary screenshots/screenshot-N[-label].png".
import { spawn } from 'node:child_process';
import { writeFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const url = process.argv[2] || 'http://localhost:3000';
const label = (process.argv[3] && !process.argv[3].startsWith('--')) ? process.argv[3] : '';
const isMobile = process.argv.includes('--mobile') || label === 'mobile';
const width = isMobile ? 390 : Number(process.env.SS_WIDTH || 1440);
// deviceScaleFactor 1 keeps full-page captures under Chrome's ~16k px image limit on long pages.
const dsf = 1;

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const userDir = join(os.tmpdir(), 'lazer-chrome-ss-' + process.pid);
const outDir = join(process.cwd(), 'temporary screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard safety timeout so this can never hang the session.
const killTimer = setTimeout(() => { console.error('TIMEOUT: aborting after 45s'); cleanup(1); }, 45000);

let chrome;
function cleanup(code) {
  try { chrome && chrome.kill('SIGKILL'); } catch {}
  rm(userDir, { recursive: true, force: true }).catch(() => {});
  clearTimeout(killTimer);
  process.exit(code);
}

function launchChrome() {
  return spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',          // auto-pick a free port (no collisions)
    `--user-data-dir=${userDir}`,
    '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    `--window-size=${width},1000`,
    'about:blank',
  ], { stdio: 'ignore' });
}

async function readDevtoolsPort() {
  const portFile = join(userDir, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) {
    if (existsSync(portFile)) {
      const txt = await readFile(portFile, 'utf8').catch(() => '');
      const port = txt.split('\n')[0].trim();
      if (port) return port;
    }
    await sleep(150);
  }
  throw new Error('DevToolsActivePort never appeared');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.events.get(msg.method) || []).forEach((cb) => cb(msg.params));
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, cb) { if (!this.events.has(method)) this.events.set(method, []); this.events.get(method).push(cb); }
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(new Error('WS error: ' + (e.message || 'failed'))));
  });
}

async function nextIncrement() {
  await mkdir(outDir, { recursive: true });
  const files = await readdir(outDir).catch(() => []);
  let max = 0;
  for (const f of files) { const m = f.match(/^screenshot-(\d+)/); if (m) max = Math.max(max, Number(m[1])); }
  return max + 1;
}

const log = (...a) => console.error('[ss]', ...a);
try {
  chrome = launchChrome();
  log('chrome spawned');
  const port = await readDevtoolsPort();
  log('devtools port', port);
  let ver;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; }
    catch { await sleep(150); }
  }
  if (!ver) throw new Error('DevTools /json/version unreachable on port ' + port);
  log('got version, connecting browser ws');

  const cdp = new CDP(await connect(ver.webSocketDebuggerUrl));
  log('ws connected');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  log('target', targetId);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  log('attached', sessionId);

  await cdp.send('Page.enable', {}, sessionId);
  log('page.enable ok; navigating');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: dsf, mobile: isMobile }, sessionId);

  const loaded = new Promise((res) => cdp.on('Page.loadEventFired', res));
  await cdp.send('Page.navigate', { url }, sessionId);
  await Promise.race([loaded, sleep(8000)]); // don't wait forever on slow CDN/iframe
  log('loaded (or 8s elapsed)');
  await sleep(1600); // let fonts settle
  // Force-reveal scroll-animated elements (IntersectionObserver won't fire below the fold in a full-page capture)
  await cdp.send('Runtime.evaluate', {
    expression: "document.querySelectorAll('.reveal').forEach(e=>{e.style.transition='none';e.classList.add('is-visible');});",
  }, sessionId);
  log('revealed');
  await sleep(250);

  // --at=<css selector> captures just that section's viewport (readable detail); otherwise full page.
  const atArg = process.argv.find((a) => a.startsWith('--at='));
  const selector = atArg ? atArg.slice(5) : '';

  const { cssContentSize } = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
  const pageW = Math.ceil(cssContentSize.width);
  let captureOpts, capW, capH;

  if (selector) {
    // Region capture by absolute element offset (no scrolling, small payload).
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: `(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return -1; const r=el.getBoundingClientRect(); return Math.max(0, r.top + window.scrollY - 24);})()`,
      returnByValue: true,
    }, sessionId);
    const y = Math.max(0, Math.round(result.value || 0));
    capW = pageW; capH = isMobile ? 860 : 1040;
    captureOpts = { format: 'jpeg', quality: 84, captureBeyondViewport: true, clip: { x: 0, y, width: capW, height: capH, scale: 1 } };
    log('section capture', selector, 'y=' + y, capW + 'x' + capH);
  } else {
    capH = Math.min(Math.ceil(cssContentSize.height), 15000);
    capW = pageW;
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: capW, height: capH, deviceScaleFactor: dsf, mobile: isMobile }, sessionId);
    await sleep(500);
    captureOpts = { format: 'jpeg', quality: 82 };
    log('full-page capture', capW, capH);
  }

  log('capturing…');
  const { data } = await cdp.send('Page.captureScreenshot', captureOpts, sessionId);
  log('captured', data.length, 'b64 chars');

  const n = await nextIncrement();
  const name = `screenshot-${n}${label ? '-' + label : ''}.jpg`;
  await writeFile(join(outDir, name), Buffer.from(data, 'base64'));
  console.log(`saved temporary screenshots/${name}  (${capW}x${capH} css, dsf ${dsf})`);
  cleanup(0);
} catch (err) {
  console.error('screenshot failed:', err.message);
  cleanup(1);
}
