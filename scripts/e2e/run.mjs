// End-to-end matrix for the live site's assistant ("Ask Fitz") and the site's interactive features.
//
//   npm run test:e2e                     build (hosted mode) and run the whole matrix 3 times
//   npm run test:e2e -- --filter conv/   only cases whose id matches the regular expression
//   npm run test:e2e -- --runs 1         fewer consecutive runs (pass^k needs k >= 3 to count)
//   E2E_SKIP_BUILD=1 npm run test:e2e    reuse the existing dist/ (must be a hosted production build)
//
// The site is the PRODUCTION build (`VITE_SITE_URL=https://www.elixirehr.com
// VITE_ELIXIR_ASSISTANT_MODE=hosted npm run build`) served on loopback; /api/chat is answered by the
// real api/lib/chat-handler.mjs with a scripted fake model (scripts/e2e/fake-model.mjs): no model,
// no live site, no Salesforce, nothing external is ever called. Headless Chrome only.
//
// pass^k: the whole matrix runs k consecutive times. A case passes only if it passes every run; one
// that fails some runs and passes others is a flake and is written to FLAKY_TESTS.md with its
// evidence. Nothing is retried until it passes.
//
// Output: work/e2e/run-<n>/trace.jsonl (per-stage trace for every case), screenshots of failures,
// work/e2e/results.json and work/e2e/summary.md. Playwright and Chrome are installed independently:
// PLAYWRIGHT_MODULE_PATH and CHROME_EXECUTABLE (default: the installed Google Chrome).
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeCases } from './cases.mjs';
import { runCase } from './harness.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const distDir = path.join(root, 'dist');
const workDir = path.join(root, 'work/e2e');
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : fallback; };
const runs = Number(option('runs', process.env.E2E_RUNS ?? 3));
const concurrency = Number(option('concurrency', process.env.E2E_CONCURRENCY ?? 6));
const filter = option('filter', process.env.E2E_FILTER ?? '');
const PENDING_CHANGES = {
  a: 'a 429 with Retry-After <= 20 s is waited out silently and retried once',
  b: 'X-Assistant-Model response header (primary | fallback-1) and a fallback model',
  c: 'up to 3 visitors served at once per server',
};

function build() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, VITE_SITE_URL: 'https://www.elixirehr.com', VITE_ELIXIR_ASSISTANT_MODE: 'hosted' };
    delete env.VITE_ELIXIR_LEAD_SUBMISSION_ENABLED;
    delete env.VITE_ELIXIR_HOSTED_PREVIEW_ENABLED;
    const log = createWriteStream(path.join(workDir, 'build.log'));
    const child = spawn('npm', ['run', 'build'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log); child.stderr.pipe(log);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed (exit ${code}); see work/e2e/build.log`))));
  });
}

async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index], index); }
  }));
  return results;
}

const pad = (text, width) => String(text).padEnd(width);

await mkdir(workDir, { recursive: true });
if (process.env.E2E_SKIP_BUILD !== '1') {
  process.stdout.write('Building the production site (hosted mode)… ');
  await build();
  console.log('done.');
}
if (!existsSync(path.join(distDir, 'app-shell.html'))) throw new Error('dist/ has no prerendered build; run without E2E_SKIP_BUILD.');

const all = makeCases({ root, distDir });
const cases = filter ? all.filter((def) => new RegExp(filter).test(def.id)) : all;
const ids = new Set();
for (const def of cases) { if (ids.has(def.id)) throw new Error(`duplicate case id ${def.id}`); ids.add(def.id); }

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : 'playwright');
const chrome = process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
console.log(`${cases.length} cases x ${runs} runs, ${concurrency} at a time.`);

const byCase = new Map(cases.map((def) => [def.id, []]));
const started = Date.now();
try {
  for (let run = 1; run <= runs; run++) {
    const runDir = path.join(workDir, `run-${run}`);
    await rm(runDir, { recursive: true, force: true });
    await mkdir(runDir, { recursive: true });
    const traceStream = createWriteStream(path.join(runDir, 'trace.jsonl'));
    const writeTrace = (event) => traceStream.write(`${JSON.stringify(event)}\n`);
    let done = 0;
    const results = await pool(cases, concurrency, async (def) => {
      let result;
      try { result = await runCase(browser, def, { run, distDir, artifactDir: runDir, writeTrace }); }
      catch (error) { result = { id: def.id, run, status: 'fail', error: `harness: ${error.message}`, screenshot: null, advisories: [] }; }
      done++;
      if (result.status === 'fail') console.log(`  run ${run} [${done}/${cases.length}] FAIL ${def.id}: ${result.error.split('\n')[0].slice(0, 160)}`);
      return result;
    });
    await new Promise((resolve) => traceStream.end(resolve));
    for (const result of results) byCase.get(result.id).push(result);
    console.log(`run ${run}: ${results.filter((r) => r.status === 'pass').length} passed, ${results.filter((r) => r.status === 'fail').length} failed`);
  }
} finally {
  await browser.close();
}

// Classify: pass^k.
const summary = cases.map((def) => {
  const results = byCase.get(def.id);
  const passes = results.filter((r) => r.status === 'pass').length;
  let status = passes === results.length ? 'pass' : passes === 0 ? 'fail' : 'flaky';
  if (status === 'fail' && def.pending) status = 'pending-change';
  const failure = results.find((r) => r.status === 'fail');
  return { id: def.id, group: def.group, pending: def.pending ?? null, status, passes, runs: results.length, error: failure?.error ?? null, screenshot: failure?.screenshot ? path.relative(root, failure.screenshot) : null, failedRuns: results.filter((r) => r.status === 'fail').map((r) => r.run), advisories: [...new Set(results.flatMap((r) => r.advisories ?? []))] };
});
const count = (status, list = summary) => list.filter((entry) => entry.status === status).length;
const groups = [...new Set(summary.map((entry) => entry.group))];
const lines = [];
lines.push(`E2E matrix: ${summary.length} cases x ${runs} runs (pass^${runs}), ${Math.round((Date.now() - started) / 1000)} s`, '');
lines.push(`| ${pad('group', 22)} | cases | pass | fail | flaky | pending-change |`, `| ${'-'.repeat(22)} | ----- | ---- | ---- | ----- | -------------- |`);
for (const group of groups) {
  const list = summary.filter((entry) => entry.group === group);
  lines.push(`| ${pad(group, 22)} | ${pad(list.length, 5)} | ${pad(count('pass', list), 4)} | ${pad(count('fail', list), 4)} | ${pad(count('flaky', list), 5)} | ${pad(count('pending-change', list), 14)} |`);
}
lines.push(`| ${pad('TOTAL', 22)} | ${pad(summary.length, 5)} | ${pad(count('pass'), 4)} | ${pad(count('fail'), 4)} | ${pad(count('flaky'), 5)} | ${pad(count('pending-change'), 14)} |`, '');
for (const status of ['fail', 'pending-change', 'flaky']) {
  const list = summary.filter((entry) => entry.status === status);
  if (!list.length) continue;
  lines.push(`${status.toUpperCase()} (${list.length}):`);
  for (const entry of list) lines.push(`- ${entry.id}${entry.pending ? ` [pending ${entry.pending}: ${PENDING_CHANGES[entry.pending]}]` : ''} (passed ${entry.passes}/${entry.runs}): ${entry.error?.split('\n')[0].slice(0, 220)}${entry.screenshot ? ` [${entry.screenshot}]` : ''}`);
  lines.push('');
}
const advisories = [...new Set(summary.flatMap((entry) => entry.advisories))];
if (advisories.length) { lines.push(`ADVISORIES (${advisories.length}, not failures):`); for (const text of advisories) lines.push(`- ${text}`); lines.push(''); }
const report = lines.join('\n');
console.log(`\n${report}`);
await writeFile(path.join(workDir, 'results.json'), JSON.stringify({ runs, cases: summary }, null, 2));
await writeFile(path.join(workDir, 'summary.md'), report);

// FLAKY_TESTS.md: flaky cases with their evidence (only from a full pass^k run, k >= 3).
if (runs >= 3 && !filter) {
  const flaky = summary.filter((entry) => entry.status === 'flaky');
  const body = ['# Flaky end-to-end tests', '', `Written by \`npm run test:e2e\` (scripts/e2e/run.mjs) from the last full pass^${runs} run on ${new Date().toISOString().slice(0, 10)}. A case that failed some runs and passed others is listed here with its evidence; it is quarantined for investigation, never retried until it passes.`, ''];
  if (!flaky.length) body.push('None in the last full run.');
  for (const entry of flaky) body.push(`## ${entry.id}`, '', `- Passed ${entry.passes} of ${entry.runs} runs; failed in run(s) ${entry.failedRuns.join(', ')}.`, `- First failure: ${entry.error?.split('\n')[0]}`, `- Evidence: work/e2e/run-${entry.failedRuns[0]}/trace.jsonl (case \`${entry.id}\`)${entry.screenshot ? `, ${entry.screenshot}` : ''}`, '');
  await writeFile(path.join(root, 'FLAKY_TESTS.md'), `${body.join('\n')}\n`);
}
process.exitCode = count('fail') + count('flaky') > 0 ? 1 : 0;
