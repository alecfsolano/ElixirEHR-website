// Runs one case: its own server (real handler + fake model), its own browser context, external
// requests stubbed (never the internet, never the live site, never Salesforce), a per-stage trace
// and the invariants every case must hold.
import assert from 'node:assert/strict';
import { PROVIDER_ENV, startServer } from './server.mjs';

export const VIEWPORTS = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

export const PENDING = 'Finding a helpful reply…';
export const DISCOVERY_URL = 'https://www.elixirehr.com/contact-us/';

// Provider, internal or model-note text that must never reach a visitor.
export const LEAK_PATTERNS = [
  /tool_use_failed|http-\d{3}|invalid-json|invalid-reply|unmarked|X-Assistant/i,
  /\bgroq\b|\bazure\b|openai|gpt-oss|api[_ -]?key|\bsystem prompt\b|You are Fitz|Knowledge data|citation_?ids?|next_?field|\bqualification\s*:|\bintent\s*:/i,
  /\b(?:analysis|commentary|assistantfinal)\b|\bthe (?:visitor|user) (?:asks?|asked|wants?|said)\b|\bwe need to\b|^\s*ANSWER:/im,
  /\bTypeError\b|\bundefined\b|\[object Object\]|\bstack trace\b|\bECONN|ERR_[A-Z_]+/,
];
// What a visitor sees from a structured reply must also be plain text (the reply contract says so).
export const MARKUP_PATTERN = /<\/?[a-z][^>]*>|https?:\/\/|\bwww\.|\[[\w-]+\]|\*\*|\]\(/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCase(browser, def, { run, distDir, artifactDir, writeTrace }) {
  const started = Date.now();
  const trace = (stage, data = {}) => writeTrace({ run, case: def.id, ms: Date.now() - started, stage, ...data });
  let script = def.script ?? (() => null);
  const env = { ...PROVIDER_ENV[def.provider ?? 'groq'], ...def.env };
  const apiLog = []; const modelLog = [];
  const record = (event) => {
    trace(event.stage, event);
    if (event.stage === 'api-request') apiLog[event.req - 1] = { ...apiLog[event.req - 1], request: event.body };
    if (event.stage === 'api-response') apiLog[event.req - 1] = { ...apiLog[event.req - 1], status: event.status, headers: event.headers, response: event.body };
    if (event.stage === 'model-request') modelLog.push(event);
  };
  const server = await startServer({ distDir, env, getScript: () => script, record });
  const base = server.url;
  const contextOptions = { ...VIEWPORTS[def.viewport ?? 'desktop'], serviceWorkers: 'block', ...(def.client ? { extraHTTPHeaders: { 'x-e2e-client': def.client } } : {}) };
  const context = await browser.newContext(contextOptions);
  const evidence = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [], external: [], navigations: [], leads: [], advisories: [] };
  const allowedStatuses = new Set(def.allowStatuses ?? []);
  const allowConsole = def.allowConsole ?? [];

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(base)) return route.continue();
    let host = '';
    try { host = new URL(url).hostname; } catch { /* data: or blob: */ }
    if (/(^|\.)salesforce\.com$|webto/i.test(host)) {
      const lead = { url, method: request.method(), postData: request.postData() ?? '' };
      evidence.leads.push(lead);
      trace('lead-intercepted', lead);
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Lead stub</title><p>e2e lead stub (not sent)</p>' });
    }
    if (request.isNavigationRequest()) {
      evidence.navigations.push(url);
      trace('external-navigation', { url });
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>External stub</title><p>e2e external stub (not fetched)</p>' });
    }
    evidence.external.push(host);
    const type = request.resourceType();
    const contentType = { script: 'text/javascript', stylesheet: 'text/css', font: 'font/woff2', image: 'image/gif' }[type] ?? 'text/plain';
    // A 1x1 GIF for images, empty bodies otherwise: nothing leaves this machine.
    const body = type === 'image' ? Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') : '';
    return route.fulfill({ status: 200, contentType, body });
  });
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const where = message.location()?.url ?? '';
    const deliberate = /Failed to load resource/.test(text) && where.includes('/api/chat') && [...allowedStatuses].some((status) => text.includes(`status of ${status}`) || (status === 'network' && /net::ERR_/.test(text)));
    if (deliberate || allowConsole.some((pattern) => pattern.test(text))) return;
    evidence.consoleErrors.push(`${text} @ ${where}`);
  });
  context.on('weberror', (error) => evidence.pageErrors.push(error.error()?.message ?? String(error)));
  context.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    const url = request.url();
    if (url.includes('/api/chat') && allowedStatuses.has('network')) return;
    // A navigation away (or a closed page) cancels in-flight loads; not a defect.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return;
    evidence.failedRequests.push(`${failure} ${url}`);
  });
  context.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(base) || response.status() < 400) return;
    if (url.includes('/api/chat') && allowedStatuses.has(response.status())) return;
    evidence.badResponses.push(`${response.status()} ${url}`);
  });

  const page = await context.newPage();
  const t = makeApi({ def, page, context, base, server, evidence, trace, apiLog, modelLog, setScript: (next) => { script = next; } });
  let error = null;
  let screenshot = null;
  try {
    await withTimeout(def.run(t), def.timeout ?? 45000, `case timed out after ${def.timeout ?? 45000} ms`);
    if (!def.skipInvariants) await t.finalInvariants();
  } catch (caught) {
    error = caught;
    try {
      screenshot = `${artifactDir}/${def.id.replaceAll('/', '__')}.png`;
      await (t.currentPage() ?? page).screenshot({ path: screenshot, fullPage: false, timeout: 5000 });
    } catch { screenshot = null; }
  } finally {
    await context.close().catch(() => {});
    await server.close().catch(() => {});
  }
  const result = { id: def.id, run, status: error ? 'fail' : 'pass', ms: Date.now() - started, error: error ? String(error.message ?? error).slice(0, 2000) : null, screenshot, advisories: evidence.advisories, apiRequests: server.apiRequests };
  trace('result', { status: result.status, error: result.error, evidence: { ...evidence, external: [...new Set(evidence.external)] } });
  return result;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

function makeApi({ def, page, context, base, server, evidence, trace, apiLog, modelLog, setScript }) {
  let current = page;
  const dialogOf = (target = current) => target.getByRole('dialog', { name: 'Ask Fitz', exact: true });
  const t = {
    def, page, context, base, server, evidence, trace, assert, sleep, setScript, apiLog, modelLog,
    currentPage: () => current,
    use(target) { current = target; return t; },
    dialog: (target) => dialogOf(target),
    async newTab() { const tab = await context.newPage(); return tab; },
    async goto(pathname, { consent = 'reject', target = current } = {}) {
      await target.goto(`${base}${pathname}`, { waitUntil: 'domcontentloaded' });
      // Wait for hydration: the launcher only renders after mount.
      await target.getByRole('button', { name: 'Ask Fitz', exact: true }).waitFor({ timeout: 15000 });
      if (consent === 'reject') await target.getByRole('button', { name: 'Reject Non-Essential', exact: true }).click();
      if (consent === 'accept') await target.getByRole('button', { name: 'Accept All', exact: true }).click();
      if (consent !== 'none') await target.locator('#cookie-banner-title').waitFor({ state: 'detached' });
      trace('visit', { path: pathname, consent });
    },
    launcher: (target = current) => target.getByRole('button', { name: 'Ask Fitz', exact: true }),
    async open(target = current) {
      await t.launcher(target).click();
      await dialogOf(target).waitFor({ state: 'visible' });
      await dialogOf(target).getByRole('textbox', { name: 'Your question', exact: true }).waitFor();
      return dialogOf(target);
    },
    composer: (target = current) => dialogOf(target).getByRole('textbox', { name: 'Your question', exact: true }),
    sendButton: (target = current) => dialogOf(target).getByRole('button', { name: 'Send message', exact: true }),
    async type(text, target = current) {
      await t.composer(target).fill(text);
      trace('visitor-input', { text: text.length > 300 ? `${text.slice(0, 300)}…(${text.length} chars)` : text });
    },
    async send(text, { via = 'enter', settle = true, target = current, timeout } = {}) {
      await t.type(text, target);
      if (via === 'enter') await t.composer(target).press('Enter');
      else await t.sendButton(target).click();
      if (settle) return t.settle({ target, timeout });
      return null;
    },
    /** Waits for the pending state to end and returns what the visitor now sees. */
    async settle({ target = current, timeout = 30000 } = {}) {
      const dialog = dialogOf(target);
      await target.waitForTimeout(50);
      try { await dialog.getByText(PENDING, { exact: true }).waitFor({ state: 'detached', timeout }); }
      catch { throw new Error(`stuck: "${PENDING}" still shown after ${timeout} ms`); }
      const shown = await t.shown(target);
      trace('shown', shown);
      // Only the message list scrolls; the panel itself never does (its header and booking bar stay put).
      const panelShift = await dialog.evaluate((node) => node.scrollTop);
      if (panelShift > 0) throw new Error(`the Fitz panel itself scrolled by ${panelShift}px, hiding its header`);
      return shown;
    },
    async shown(target = current) {
      const dialog = dialogOf(target);
      const messages = await dialog.locator('[role="log"] article').evaluateAll((nodes) => nodes.map((node) => ({ speaker: node.querySelector('span')?.textContent, text: [...node.querySelectorAll('p')].map((paragraph) => paragraph.textContent).join('\n\n'), links: [...node.querySelectorAll('a')].map((a) => ({ text: a.textContent, href: a.href, target: a.target })) })));
      const alert = dialog.getByRole('alert');
      const error = (await alert.count()) ? await alert.innerText() : '';
      const card = dialog.locator('section[aria-labelledby="elixir-discovery-heading"]');
      const cardText = (await card.count()) ? await card.innerText() : '';
      return { messages, last: messages.at(-1) ?? null, error, card: cardText, transcriptText: messages.map((message) => message.text).join('\n') };
    },
    apiCount: () => server.apiRequests,
    async waitApi(n, timeout = 15000) {
      const deadline = Date.now() + timeout;
      while (server.apiRequests < n) {
        if (Date.now() > deadline) throw new Error(`expected ${n} /api/chat requests, saw ${server.apiRequests}`);
        await sleep(50);
      }
    },
    advisory(text) { evidence.advisories.push(text); trace('advisory', { text }); },
    /** The visitor sees an answer, or a clear message with a next step (the discovery-call link). */
    async assertAnswerOrNextStep(shown, target = current) {
      const dialog = dialogOf(target);
      if (shown.error) {
        assert.ok(shown.error.trim().length > 10, 'error message is not blank');
        assert.ok((await dialog.getByRole('alert').getByRole('link', { name: /Book a discovery call/ }).count()) === 1, 'the error pairs a "Book a discovery call" link');
        const href = await dialog.getByRole('alert').getByRole('link', { name: /Book a discovery call/ }).getAttribute('href');
        assert.equal(href, DISCOVERY_URL);
      } else {
        assert.equal(shown.last?.speaker, 'Fitz', `the last message is from Fitz (saw ${shown.last?.speaker}: ${shown.last?.text?.slice(0, 80)})`);
        assert.ok(shown.last.text.trim().length > 0, 'the answer is not empty');
      }
    },
    assertNoLeak(text, label = 'dialog') {
      for (const pattern of LEAK_PATTERNS) assert.doesNotMatch(text, pattern, `${label} shows provider/internal text (${pattern})`);
    },
    async dialogText(target = current) { return (await dialogOf(target).count()) && (await dialogOf(target).isVisible()) ? dialogOf(target).innerText() : ''; },
    async finalInvariants() {
      for (const target of context.pages()) {
        if (target.isClosed() || !target.url().startsWith(base)) continue;
        const dialog = dialogOf(target);
        if (await dialog.count()) {
          assert.equal(await dialog.getByText(PENDING, { exact: true }).count(), 0, `stuck: "${PENDING}" still shown at the end`);
          // Everything Fitz or the page says (not the visitor's own words).
          const text = await dialog.evaluate((node) => [...node.querySelectorAll('[role="log"] article')].filter((article) => article.querySelector('span')?.textContent !== 'You').map((article) => article.innerText).concat([...node.querySelectorAll('[role="alert"], [role="status"], section, footer, header')].map((part) => part.innerText)).join('\n'));
          t.assertNoLeak(text);
        }
      }
      assert.deepEqual(evidence.pageErrors, [], 'uncaught page errors');
      assert.deepEqual(evidence.consoleErrors, [], 'console errors');
      assert.deepEqual(evidence.failedRequests, [], 'failed requests');
      assert.deepEqual(evidence.badResponses, [], 'unexpected HTTP error responses');
    },
    /** Is the element's centre the top-most hit target (i.e. clickable, not covered)? */
    async hitTest(locator) {
      return locator.evaluate((node) => {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) return { visible: false };
        const x = box.left + box.width / 2; const y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return { visible: true, inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight, clickable: Boolean(top && (top === node || node.contains(top))), coveredBy: top && !(top === node || node.contains(top)) ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}.${String(top.className).slice(0, 60)}` : null };
      });
    },
  };
  return t;
}
