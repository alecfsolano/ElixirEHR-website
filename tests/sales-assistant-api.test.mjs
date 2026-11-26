import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatHandler } from '../api/lib/chat-handler.mjs';
import { createHostedModel, questionOnOwnLine } from '../api/lib/hosted-model.mjs';
import { retrieveKnowledge } from '../api/lib/knowledge.mjs';

const env = { ASSISTANT_ENABLED: 'true', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_DEPLOYMENT: 'configured-small-model', AZURE_OPENAI_API_KEY: 'test-only-not-a-real-key' };
const knowledge = [{ id: 'ehr', status: 'approved', owner: 'Test product owner', reviewedAt: '2026-11-13', title: 'EHR overview', url: 'https://www.elixirehr.com/electronic-health-record/', content: 'Approved test fixture: EHR information for a test organization.' }];
const body = { messages: [{ role: 'user', content: 'Our current EHR is Epic. Tell me about your EHR.' }], qualification: {}, sourcePath: '/electronic-health-record/' };

test('disabled, missing configuration and unapproved knowledge make zero model calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected paid call'); };
  assert.equal((await createChatHandler({ env: {}, knowledge, fetchImpl })(body)).status, 503);
  assert.equal((await createChatHandler({ env: { ASSISTANT_ENABLED: 'true' }, knowledge, fetchImpl })(body)).status, 503);
  const result = await createChatHandler({ env, knowledge: knowledge.map((entry) => ({ ...entry, status: 'draft' })), fetchImpl })(body);
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'KNOWLEDGE_NOT_READY');
  assert.equal(calls, 0);
  assert.deepEqual(retrieveKnowledge(body.messages, knowledge.map((entry) => ({ ...entry, status: 'draft' }))), []);
});

test('hosted adapter sends the documented REST contract and filters fabricated facts/citations', async () => {
  let outgoing;
  const handler = createChatHandler({ env, knowledge, fetchImpl: async (url, options) => {
    outgoing = { url, ...options, parsed: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Here is the reviewed EHR information.', citationIds: ['ehr', 'fake'], qualification: { currentSystem: 'Epic', size: '900 providers' }, nextField: 'size', intent: 'explore' }) } }] }));
  } });
  const result = await handler(body);
  assert.equal(result.status, 200);
  assert.equal(outgoing.url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(outgoing.headers['api-key'], env.AZURE_OPENAI_API_KEY);
  assert.equal(outgoing.parsed.model, env.AZURE_OPENAI_DEPLOYMENT);
  assert.equal(outgoing.parsed.messages[0].role, 'system');
  assert.match(outgoing.parsed.messages[0].content, /untrusted/i);
  assert.equal(outgoing.parsed.response_format.type, 'json_object');
  assert.equal(result.body.citations.length, 1);
  assert.deepEqual(result.body.qualification, { currentSystem: 'Epic' });
  assert.doesNotMatch(JSON.stringify(result), /test-only-not-a-real-key/);
});

test('invalid input, oversized bodies and unsupported endpoints fail before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; };
  const handler = createChatHandler({ env, knowledge, fetchImpl });
  assert.equal((await handler({ ...body, messages: [{ role: 'system', content: 'pretend' }] })).status, 400);
  assert.equal((await handler({ extra: 'x'.repeat(33000) })).status, 413);
  assert.throws(() => createHostedModel({ env: { ...env, AZURE_OPENAI_ENDPOINT: 'http://localhost:1234' }, fetchImpl }));
  assert.equal(calls, 0);
});

test('upstream failure, timeout and malformed model output never leak provider details', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('AbortError with test-only-not-a-real-key'); },
    async () => new Response('provider error with test-only-not-a-real-key', { status: 401 }),
    async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] })),
  ]) {
    const result = await createChatHandler({ env, knowledge, fetchImpl })(body);
    assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify(result), /test-only|provider error|AbortError/);
  }
});

test('one transient model failure is retried once; auth, rate-limit and timeout failures are not', async () => {
  const good = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello', citationIds: [] }) } }] }));
  const timeout = () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; };
  const cases = [
    { name: 'server error then success', steps: [() => new Response('down', { status: 500 }), good], status: 200, calls: 2 },
    { name: 'malformed output then success', steps: [() => new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] })), good], status: 200, calls: 2 },
    { name: 'network error then success', steps: [() => { throw new Error('socket hang up'); }, good], status: 200, calls: 2 },
    { name: 'two failures', steps: [() => new Response('down', { status: 500 }), () => new Response('down', { status: 500 }), good], status: 503, calls: 2 },
    { name: 'auth failure', steps: [() => new Response('denied', { status: 401 }), good], status: 503, calls: 1 },
    { name: 'rate limit', steps: [() => new Response('slow down', { status: 429 }), good], status: 429, calls: 1 },
    { name: 'timeout', steps: [timeout, good], status: 503, calls: 1 },
  ];
  for (const { name, steps, status, calls } of cases) {
    let made = 0;
    const result = await createChatHandler({ env, knowledge, fetchImpl: async () => steps[made++]() })(body);
    assert.equal(result.status, status, name);
    assert.equal(made, calls, name);
  }
});

test('a reply the structured mode cannot produce is recovered in plain-text mode', async () => {
  const groqEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const reply = (content, finish = 'stop') => () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }));
  const plain = reply('ANSWER: Elixir can add revenue cycle to a clinical-only setup. What size is your organization?');
  const rejected = (code) => () => new Response(JSON.stringify({ error: { message: 'private provider details', code } }), { status: 400 });
  const cases = [
    { name: 'provider rejected its own structured output', steps: [rejected('json_validate_failed'), plain], reason: 'http-400-json_validate_failed' },
    { name: 'provider code outside the safe vocabulary is dropped', steps: [rejected('Secret: test-placeholder-key'), plain], reason: 'http-400' },
    { name: 'empty content', steps: [reply(''), plain], reason: 'empty' },
    { name: 'null content', steps: [reply(null), plain], reason: 'empty' },
    { name: 'truncated JSON', steps: [reply('{"answer":"Eli', 'length'), plain], reason: 'truncated' },
    { name: 'invalid JSON', steps: [reply('oops'), plain], reason: 'invalid-json' },
    { name: 'blank answer', steps: [reply(JSON.stringify({ answer: ' ', citationIds: [] })), plain], reason: 'invalid-reply' },
  ];
  for (const { name, steps, reason } of cases) {
    const sent = [];
    const result = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return steps[sent.length - 1](); } })(body);
    assert.equal(result.status, 200, name);
    assert.equal(result.body.answer, 'Elixir can add revenue cycle to a clinical-only setup.\n\nWhat size is your organization?', name);
    assert.deepEqual(result.body.citations, [], name);
    assert.equal(result.body.intent, 'explore', name);
    assert.equal(result.headers['X-Assistant-Recovered'], reason, name);
    assert.doesNotMatch(JSON.stringify(result), /private provider|test-placeholder/, name);
    assert.equal(sent.length, 2, name);
    assert.equal(sent[0].response_format.type, 'json_schema', name);
    assert.equal(sent[1].response_format, undefined, name);
    assert.match(sent[1].messages[0].content, /ANSWER:/, name);
    assert.doesNotMatch(sent[1].messages[0].content, /Return a JSON object/, name);
    assert.match(sent[1].messages[0].content, /Never convert headcount into a license count/, name);
    assert.deepEqual(sent[1].messages.slice(1), sent[0].messages.slice(1), name);
  }
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('plain-text recovery accepts a finished answer without the exact marker and nothing else', async () => {
  const groqEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const rejected = () => new Response(JSON.stringify({ error: { message: 'private provider details', code: 'tool_use_failed', failed_generation: 'private generation' } }), { status: 400 });
  const run = async (content, finish = 'stop') => {
    const steps = [rejected, () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }))];
    let made = 0;
    const result = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async () => steps[made++]() })(body);
    assert.equal(made, 2);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    return result;
  };
  const answer = 'Elixir can add revenue cycle to a clinical-only setup. What size is your organization?';
  const unmarked = 'Yes. Elixir covers behavioral health and home visits on one record.\n\nMany teams start with scheduling, then add billing. How many sites do you run?';
  const screens = 'The user interface stays the same for clinicians, and revenue cycle is added to it.';
  const telehealth = 'We have a telehealth capability that works with the same patient record.';
  const ordinary = [
    'Yes, Elixir supports telehealth visits.', 'Hi! What kind of care do you provide?', 'Happy to help. What is your timeline? 😊',
    'Thinking about switching from Epic? Elixir can migrate your records in phases.', 'Analysis of denials is built into Elixir billing.',
    'Elixir exchanges FHIR resources as JSON. Which systems do you use?', 'User permissions are set by role. A user has access only to what that role allows.',
    'Should you add sites later, each one can share the same record.', 'Licensing is confirmed by the Elixir team. Which staff roles need access?',
    'Elixir funciona con su equipo. ¿Cuántas sedes tiene?',
  ];
  const quoted = '"Clinical only" setups can add revenue cycle. (Most teams do this in phases.)';
  for (const [content, expected] of [
    [answer, answer], [`  ${answer}\n`, answer], [`Answer: ${answer}`, answer], [`**ANSWER:** ${answer}`, answer], [`**ANSWER**: ${answer}`, answer], [`ANSWER\uFF1A ${answer}`, answer],
    [unmarked, unmarked], [screens, screens], [telehealth, telehealth], [quoted, quoted],
    [`# ANSWER:\n${answer}`, answer], [`ANSWER\n\n${answer}`, answer], [`**ANSWER: ${answer}**`, answer],
    ['Elixir fits, so **what size is your organization?**', 'Elixir fits, so what size is your organization?'],
    ...ordinary.map((text) => [text, text]),
  ]) {
    const result = await run(content);
    assert.equal(result.status, 200, content);
    assert.equal(result.body.answer, questionOnOwnLine(expected), content);
    assert.deepEqual(result.body.citations, [], content);
    assert.deepEqual(result.body.qualification, {}, content);
    assert.equal(result.headers['X-Assistant-Recovered'], 'http-400-tool_use_failed', content);
  }
  for (const [content, reason, finish] of [
    ['Thinking about what to say', 'unmarked'],
    ['Yes, it does.', 'unmarked'],
    ['Elixir can add revenue cycle to a clinical-only setup and then', 'unmarked'],
    [answer, 'truncated', 'length'],
    [`{"answer":"${answer}" and more.`, 'unmarked-control'],
    [`<|channel|>commentary to=functions.reply<|message|>${answer}`, 'unmarked-control'],
    [`<p>${answer}</p> That is all we can say here.`, 'unmarked-control'],
    ['```\nElixir can add revenue cycle to a clinical-only setup.\n``` That is all.', 'unmarked-control'],
    [`See https://example.com for more. ${answer}`, 'unmarked-control'],
    [`We need to answer with plain text. ${answer}`, 'unmarked-notes'],
    [`The user asks about modules. ${answer}`, 'unmarked-notes'],
    [`Visitor wants both modules. ${answer}`, 'unmarked-notes'],
    [`Let me think about this one. ${answer}`, 'unmarked-notes'],
    [`Set nextField to size and reply. ${answer}`, 'unmarked-notes'],
    ['analysisUser asks about pricing. Must not invent.assistantfinalPricing is scoped with the team.', 'unmarked-notes'],
    ['analysisWe need to answer about billing. Provide short answer and ask a question.', 'unmarked-notes'],
    [`Done with that.assistantfinal${answer}`, 'unmarked-notes'],
    ['Need to answer pricing. Must not quote a number and recommend discovery call.', 'unmarked-notes'],
    ['We need to ask one qualifying question and recommend a discovery call.', 'unmarked-notes'],
    ['We should mention the billing module and ask about size. Keep to 2-5 sentences.', 'unmarked-notes'],
    ['Okay, the user wants to know about billing. I should answer briefly and ask about size.', 'unmarked-notes'],
    ['So the user asks whether we do billing. Short reply is best here.', 'unmarked-notes'],
    ['Elixir does billing. Keep it brief and friendly for them.', 'unmarked-notes'],
    [`They ask about pricing. According to the rules we must not quote a number.\nANSWER: ${answer}`, 'unmarked-notes'],
    [`Sure! ANSWER: ${answer}`, 'unmarked-notes'],
    ['answer: Elixir does billing.\nnextField: size\nintent: the visitor wants a demo.', 'unmarked-notes'],
    ['answer: "Elixir does billing."\ncitationIds: [billing-1]\nnextField: size.', 'unmarked-control'],
    ['Answer: {"answer":"Elixir does", "citationIds":["a"', 'unmarked-control'],
    [`Answer: ${answer}`, 'truncated', 'length'],
    ['["Elixir can add billing to a clinical-only setup.", "What size?"', 'unmarked-control'],
    ['Elixir adds billing to clinical teams [elixir-rcm]. What size are you?', 'unmarked-control'],
    ['Please see www.example.com for more details on it.', 'unmarked-control'],
    ['Please see [our page](//example.com/a) for more details on it.', 'unmarked-control'],
    ['x'.repeat(4001) + '.', 'invalid-reply'],
  ]) {
    const result = await run(content, finish);
    assert.equal(result.status, 503, content);
    assert.equal(result.headers['X-Assistant-Failed'], `http-400-tool_use_failed,${reason}`, content);
    assert.doesNotMatch(JSON.stringify(result), /revenue cycle/, content);
  }
});

test('plain-text recovery rejects an unfinished reply and reports why it failed', async () => {
  const groqEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const reply = (content) => () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  const cases = [
    { name: 'unmarked text', steps: [reply('oops'), reply('Thinking about what to say')], failed: 'invalid-json,unmarked' },
    { name: 'marker with no answer', steps: [reply(''), reply('ANSWER:   ')], failed: 'empty,invalid-reply' },
    { name: 'oversized answer', steps: [reply(''), reply(`ANSWER: ${'x'.repeat(4001)}`)], failed: 'empty,invalid-reply' },
    { name: 'server down twice', steps: [() => new Response('down', { status: 500 }), () => new Response('down', { status: 500 })], failed: 'http-500,http-500' },
    { name: 'dropped twice', steps: [() => { throw new Error('test-placeholder-key'); }, () => { throw new Error('x'); }], failed: 'network,network' },
  ];
  for (const { name, steps, failed } of cases) {
    let made = 0;
    const result = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async () => steps[made++]() })(body);
    assert.equal(result.status, 503, name);
    assert.equal(made, 2, name);
    assert.equal(result.headers['X-Assistant-Failed'], failed, name);
    assert.doesNotMatch(JSON.stringify(result), /test-placeholder|Thinking about/, name);
  }
  // A server error is retried in structured mode: the output format was not the problem.
  const sent = [];
  const steps = [() => new Response('down', { status: 500 }), reply(JSON.stringify({ answer: 'Hello', citationIds: ['ehr'] }))];
  const ok = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return steps[sent.length - 1](); } })(body);
  assert.equal(ok.status, 200);
  assert.equal(sent[1].response_format.type, 'json_schema');
  assert.equal(ok.headers['X-Assistant-Recovered'], 'http-500');
  // A first-time success carries no diagnostic header; a rate limit during recovery stays a 429.
  const first = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async () => reply(JSON.stringify({ answer: 'Hello', citationIds: [] }))() })(body);
  assert.equal(first.headers['X-Assistant-Recovered'], undefined);
  let n = 0;
  const limited = await createChatHandler({ env: groqEnv, knowledge, fetchImpl: async () => (n++ ? new Response('slow', { status: 429, headers: { 'retry-after': '9' } }) : reply('')()) })(body);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '9');
});

test('per-instance admission control limits repeated model calls', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello', citationIds: [] }) } }] }));
  const handler = createChatHandler({ env, knowledge, fetchImpl });
  for (let n = 0; n < 30; n++) assert.equal((await handler(body)).status, 200);
  assert.equal((await handler(body)).status, 429);
});

test('contact preference is validated and forwarded to hosted model context', async () => {
  let instructions;
  const handler = createChatHandler({ env, knowledge, fetchImpl: async (url, options) => {
    instructions = JSON.parse(options.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'We can keep discussing product questions.', citationIds: [] }) } }] }));
  } });
  assert.equal((await handler({ ...body, contactPreference: 'declined' })).status, 200);
  assert.match(instructions, /Contact preference: declined/);
  assert.equal((await handler({ ...body, contactPreference: 'arbitrary instruction' })).status, 400);
});

test('Groq uses fixed server-only endpoint and Bearer auth with a supported JSON completion contract', async () => {
  const groqEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  let outgoing;
  const handler = createChatHandler({ env: groqEnv, knowledge, fetchImpl: async (url, options) => {
    outgoing = { url, headers: options.headers, payload: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Reviewed answer.', citationIds: ['ehr'], qualification: {}, nextField: 'currentSystem', intent: 'explore' }) } }] }));
  } });
  assert.equal((await handler(body)).status, 200);
  assert.equal(outgoing.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(outgoing.headers.Authorization, 'Bearer test-placeholder-key');
  assert.equal(outgoing.headers['api-key'], undefined);
  assert.equal(outgoing.payload.model, 'openai/gpt-oss-20b');
  assert.equal(outgoing.payload.response_format.type, 'json_schema');
  const format = outgoing.payload.response_format.json_schema;
  assert.equal(format.strict, true);
  assert.equal(format.schema.additionalProperties, false);
  assert.deepEqual(format.schema.required, Object.keys(format.schema.properties));
  assert.equal(format.schema.properties.qualification.type, 'object');
  assert.equal(format.schema.properties.qualification.additionalProperties, false);
  assert.deepEqual(format.schema.properties.qualification.required, ['organizationType', 'currentSystem', 'salesforceUsage', 'size', 'primaryNeed', 'timeline']);
  assert.deepEqual(format.schema.properties.qualification.properties.size.type, ['string', 'null']);
  assert.equal(outgoing.payload.tools, undefined);
});

test('licensing questions use strict replies, retain literal headcount and forbid invented license rules', async () => {
  let instructions;
  const handler = createChatHandler({ env: { ...env, ASSISTANT_PROVIDER: 'groq', GROQ_MODEL: 'openai/gpt-oss-20b', GROQ_API_KEY: 'test-placeholder-key' }, knowledge: knowledge.map((entry) => ({ ...entry, content: 'Clinic EHR product and licensing information must be confirmed.' })), fetchImpl: async (_url, options) => {
    instructions = JSON.parse(options.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answer: 'The team needs to confirm licensing. Which roles need access?', citationIds: ['ehr'], qualification: { organizationType: 'healthcare clinic', currentSystem: null, salesforceUsage: null, size: '40 people', primaryNeed: null, timeline: null }, nextField: 'currentSystem', intent: 'explore' }) } }] }));
  } });
  const result = await handler({ ...body, messages: [{ role: 'user', content: 'We are a 40 people xyz healthcare clinic, we wanted to understand how Elixir can help and how many licenses we need' }] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.qualification, { organizationType: 'healthcare clinic', size: '40 people' });
  assert.match(instructions, /Never convert headcount into a license count/);
});

test('Groq quota errors return a sanitized retryable response instead of losing the conversation', async () => {
  const result = await createChatHandler({ env: { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' }, knowledge, fetchImpl: async () => new Response('private provider details', { status: 429, headers: { 'retry-after': '12' } }) })(body);
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '12');
  assert.doesNotMatch(JSON.stringify(result.body), /private provider|test-placeholder/);
});

test('draft website knowledge is available only with the explicit latest review environment', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'A draft source answer.', citationIds: ['ehr'] }) } }] })); };
  const draft = knowledge.map((entry) => ({ ...entry, status: 'draft' }));
  assert.equal((await createChatHandler({ env: { ...env, ASSISTANT_KNOWLEDGE_MODE: 'review' }, knowledge: draft, fetchImpl })(body)).status, 503);
  const enabled = await createChatHandler({ env: { ...env, ASSISTANT_KNOWLEDGE_MODE: 'review', ASSISTANT_REVIEW_ENVIRONMENT: 'latest' }, knowledge: draft, fetchImpl })(body);
  assert.equal(enabled.status, 200);
  assert.equal(calls, 1);
});

test('Groq protection serves three visitors at once, caps calls per worker and says how long to wait', async () => {
  const waiting = [];
  let calls = 0;
  const handler = createChatHandler({ env: { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' }, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => {
    calls++;
    if (calls <= 3) await new Promise((resolve) => { waiting.push(resolve); });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello', citationIds: [] }) } }] }));
  } });
  const pending = [handler(body), handler(body), handler(body)];
  await new Promise((resolve) => setImmediate(resolve));
  const busy = await handler(body);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers['Retry-After'], '3');
  assert.equal(calls, 3);
  waiting.forEach((resolve) => resolve());
  for (const result of await Promise.all(pending)) assert.equal(result.status, 200);
  for (let n = 3; n < 10; n++) assert.equal((await handler(body)).status, 200, `call ${n + 1}`);
  const full = await handler(body);
  assert.equal(full.status, 429);
  assert.ok(Number(full.headers['Retry-After']) >= 1 && Number(full.headers['Retry-After']) <= 60, full.headers['Retry-After']);
  assert.equal(calls, 10);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('a rate-limited, failing or slow model hands the turn to the configured fallback model', async () => {
  const fallbackEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b', GROQ_FALLBACK_MODELS: 'openai/gpt-oss-120b' };
  const good = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello from the fallback.', citationIds: [] }) } }] }));
  const limited = (seconds) => () => new Response('limited', { status: 429, headers: { 'retry-after': String(seconds) } });
  const down = () => new Response('down', { status: 500 });
  const slow = () => { const error = new Error('slow'); error.name = 'TimeoutError'; throw error; };
  const run = async (steps, env = fallbackEnv) => {
    const sent = [];
    const result = await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return steps[sent.length - 1](); } })(body);
    return { result, models: sent.map((payload) => payload.model), sent };
  };
  let { result, models } = await run([limited(7), good]);
  assert.equal(result.status, 200);
  assert.equal(result.body.answer, 'Hello from the fallback.');
  assert.deepEqual(models, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  assert.equal(result.headers['X-Assistant-Model'], 'fallback-1');
  assert.equal(result.headers['X-Assistant-Recovered'], 'rate-limited');
  ({ result, models } = await run([down, down, good]));
  assert.equal(result.status, 200);
  assert.deepEqual(models, ['openai/gpt-oss-20b', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  assert.equal(result.headers['X-Assistant-Recovered'], 'http-500,http-500');
  ({ result, models } = await run([slow, good]));
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Assistant-Recovered'], 'timeout');
  ({ result, models } = await run([limited(9), limited(4)]));
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '4');
  assert.equal(models.length, 2);
  ({ result, models } = await run([() => new Response('no', { status: 401 }), good]));
  assert.equal(result.status, 503);
  assert.deepEqual(models, ['openai/gpt-oss-20b']);
  ({ result, models } = await run([good]));
  assert.equal(result.headers['X-Assistant-Model'], 'primary');
  // Without a fallback configured, a rate limit is returned as before.
  ({ result, models } = await run([limited(5), good], { ...fallbackEnv, GROQ_FALLBACK_MODELS: '' }));
  assert.equal(result.status, 429);
  assert.deepEqual(models, ['openai/gpt-oss-20b']);
  // Only well-formed, distinct model names are used; a non-GPT-OSS fallback gets JSON-object mode and no reasoning setting.
  let sent;
  ({ result, models, sent } = await run([limited(5), limited(5), good], { ...fallbackEnv, GROQ_FALLBACK_MODELS: 'openai/gpt-oss-20b, bad model!, openai/gpt-oss-120b , meta-llama/llama-4-scout-17b-16e-instruct' }));
  assert.deepEqual(models, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'meta-llama/llama-4-scout-17b-16e-instruct']);
  assert.equal(result.headers['X-Assistant-Model'], 'fallback-2');
  assert.equal(sent[1].reasoning_effort, 'low');
  assert.equal(sent[2].response_format.type, 'json_object');
  assert.equal(sent[2].reasoning_effort, undefined);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('Azure is primary and the Groq models back it up across providers', async () => {
  const crossEnv = { ...env, ASSISTANT_PROVIDER: 'azure', AZURE_OPENAI_STRICT_SCHEMA: 'true', AZURE_OPENAI_REASONING_EFFORT: 'low', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b', GROQ_FALLBACK_MODELS: 'openai/gpt-oss-120b' };
  const good = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello from a model.', citationIds: [] }) } }] }));
  const limited = (seconds) => () => new Response('limited', { status: 429, headers: { 'retry-after': String(seconds) } });
  const run = async (steps, runEnv = crossEnv) => {
    const sent = [];
    const result = await createChatHandler({ env: runEnv, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async (url, options) => { sent.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return steps[sent.length - 1](); } })(body);
    return { result, sent };
  };
  // Azure answers first, with the strict reply schema and the configured reasoning effort.
  let { result, sent } = await run([good]);
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Assistant-Model'], 'primary');
  assert.equal(sent[0].url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assert.equal(sent[0].headers['api-key'], env.AZURE_OPENAI_API_KEY);
  assert.equal(sent[0].headers.Authorization, undefined);
  assert.equal(sent[0].body.response_format.type, 'json_schema');
  assert.equal(sent[0].body.response_format.json_schema.strict, true);
  assert.equal(sent[0].body.reasoning_effort, 'low');
  // A rate-limited Azure deployment hands the turn to Groq with Groq's own key; the Azure key never leaves for Groq.
  ({ result, sent } = await run([limited(30), good]));
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Assistant-Model'], 'fallback-1');
  assert.equal(sent[1].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent[1].body.model, 'openai/gpt-oss-20b');
  assert.equal(sent[1].headers['api-key'], undefined);
  assert.equal(sent[1].headers.Authorization, 'Bearer test-placeholder-key');
  // A rejected Azure key skips to Groq instead of failing the visitor.
  ({ result, sent } = await run([() => new Response('no', { status: 401 }), good]));
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Assistant-Model'], 'fallback-1');
  assert.equal(result.headers['X-Assistant-Recovered'], 'config');
  // A rejected Groq key skips the other Groq model too; with every provider down the visitor gets the 503.
  ({ result, sent } = await run([() => new Response('no', { status: 401 }), () => new Response('no', { status: 403 })]));
  assert.equal(result.status, 503);
  assert.equal(sent.length, 2);
  // All three limited: the shortest wait is returned.
  ({ result, sent } = await run([limited(30), limited(9), limited(4)]));
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '4');
  // Without a Groq key, Azure stands alone; without the opt-ins, Azure keeps JSON-object mode and no reasoning setting.
  ({ result, sent } = await run([limited(5), good], { ...env, ASSISTANT_PROVIDER: 'azure' }));
  assert.equal(result.status, 429);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.response_format.type, 'json_object');
  assert.equal(sent[0].body.reasoning_effort, undefined);
  // An unknown reasoning effort is ignored rather than sent.
  ({ sent } = await run([good], { ...crossEnv, AZURE_OPENAI_REASONING_EFFORT: 'turbo' }));
  assert.equal(sent[0].body.reasoning_effort, undefined);
  // An incomplete Groq setting is ignored: Azure still serves alone.
  ({ result, sent } = await run([good], { ...crossEnv, GROQ_MODEL: '' }));
  assert.equal(result.status, 200);
  // A mix of rate limits and rejected keys is a wait, not an outage: the shortest wait is returned.
  ({ result, sent } = await run([() => new Response('no', { status: 401 }), limited(9), limited(4)]));
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '4');
  ({ result, sent } = await run([limited(30), () => new Response('no', { status: 401 })]));
  assert.equal(result.status, 429);
  assert.equal(result.headers['Retry-After'], '30');
  assert.equal(sent.length, 2);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('a slow Azure deployment leaves the Groq fallback time to answer', async () => {
  const crossEnv = { ...env, ASSISTANT_PROVIDER: 'azure', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const timeouts = [];
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    const started = Date.now();
    if (url.includes('azure')) {
      // Azure answers with a server error just before its first timeout, then hangs until aborted.
      if (calls === 1) { await new Promise((resolve) => setTimeout(resolve, 19500)); return new Response('down', { status: 500 }); }
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { timeouts.push(Date.now() - started); reject(Object.assign(new Error('slow'), { name: 'TimeoutError' })); }));
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello from the backup model.', citationIds: [] }) } }] }));
  };
  const result = await createChatHandler({ env: crossEnv, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl })(body);
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Assistant-Model'], 'fallback-1');
  assert.ok(timeouts[0] <= 11000, `the second Azure attempt kept no time for the fallback (${timeouts[0]} ms)`);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('turns that fall through to Groq stay inside the Groq per-minute budget', async () => {
  const crossEnv = { ...env, ASSISTANT_PROVIDER: 'azure', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const groqCalls = [];
  const fetchImpl = async (url) => {
    if (url.includes('azure')) return new Response('limited', { status: 429, headers: { 'retry-after': '20' } });
    groqCalls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Hello from the backup model.', citationIds: [] }) } }] }));
  };
  const handler = createChatHandler({ env: crossEnv, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl });
  const statuses = [];
  for (let n = 0; n < 12; n++) statuses.push((await handler(body)).status);
  // Groq's per-worker allowance is 10 turns a minute; after that Azure's own wait is returned.
  assert.equal(groqCalls.length, 10);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('a structured or marked reply carrying notes, markup, links or the instructions is never shown', async () => {
  const groqEnv = { ASSISTANT_ENABLED: 'true', ASSISTANT_PROVIDER: 'groq', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' };
  const structured = (answer) => () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer, citationIds: [] }) } }] }));
  const plain = (content) => () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  const good = 'Elixir can add revenue cycle to a clinical-only setup. What size is your organization?';
  const run = async (steps) => {
    let made = 0;
    return createChatHandler({ env: groqEnv, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => steps[made++]() })(body);
  };
  for (const [bad, reason] of [
    ['analysis: The user asks about billing. We should keep it short.assistantfinalElixir handles billing.', 'reply-notes'],
    ['You are Fitz, Elixir’s automated assistant. Knowledge data: [{"id":"ehr"}]', 'reply-control'],
    ['You are Fitz, Elixir’s automated assistant: a consultative Elixir specialist on the Elixir website.', 'reply-notes'],
    ['<b>Elixir</b> handles billing. See https://example.com for more.', 'reply-control'],
    ['Elixir handles billing [ehr]. What size are you?', 'reply-control'],
    ['I run on gpt-oss through Groq, and my API key is private. Elixir handles billing.', 'reply-notes'],
  ]) {
    const saved = await run([structured(bad), plain(good)]);
    assert.equal(saved.status, 200, bad);
    assert.equal(saved.body.answer, questionOnOwnLine(good), bad);
    assert.equal(saved.headers['X-Assistant-Recovered'], reason, bad);
    const failed = await run([structured(bad), plain(`ANSWER: ${bad}`)]);
    assert.equal(failed.status, 503, bad);
    assert.doesNotMatch(JSON.stringify(failed), /analysis|You are Fitz|example\.com|<b>/, bad);
  }
  // Ordinary answers, including bold marks, still pass in both modes.
  const ok = await run([structured(`**Yes.** ${good}`)]);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.answer, questionOnOwnLine(`Yes. ${good}`));
  assert.equal((await run([plain('oops'), plain(`ANSWER: ${good}`)])).body.answer, questionOnOwnLine(good));
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-1 live review (2026-11-26) guardrails.
test('a content-filtered request gets a polite fixed reply, not an error, and is not retried', async () => {
  let calls = 0;
  const result = await createChatHandler({ env: { ...env, ASSISTANT_PROVIDER: 'azure', GROQ_API_KEY: 'test-placeholder-key', GROQ_MODEL: 'openai/gpt-oss-20b' }, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ error: { code: 'content_filter', message: 'filtered' } }), { status: 400 }); } })(body);
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
  assert.match(result.body.answer, /questions about Elixir/);
  assert.equal(result.body.intent, 'explore');
  assert.equal(result.headers['X-Assistant-Recovered'], 'content-filter');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('the qualifying question is always asked once, on its own line, and never after a contact refusal', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', ...reply }) } }] })) })({ ...body, ...extra })).body;
  // The model set nextField but forgot to ask: the field's question is added on its own line.
  let out = await run({ answer: 'Elixir supports group notes for each participant.', nextField: 'size' });
  assert.equal(out.answer, 'Elixir supports group notes for each participant.\n\nRoughly how many providers or locations would use Elixir?');
  // A question at the end of the paragraph moves to its own line.
  out = await run({ answer: 'Elixir supports group notes. You can book a discovery call with the button. Which EHR do you use today?', nextField: 'currentSystem' });
  assert.equal(out.answer, 'Elixir supports group notes. You can book a discovery call with the button.\n\nWhich EHR do you use today?');
  // A field already answered or skipped is passed over for the next unknown one.
  out = await run({ answer: 'Elixir supports group notes.', nextField: 'size' }, { qualification: { size: '20 providers' } });
  assert.equal(out.answer, 'Elixir supports group notes.\n\nWhat kind of healthcare organization are you with?');
  out = await run({ answer: 'Elixir supports group notes.', nextField: 'size' }, { skipped: ['size'] });
  assert.equal(out.answer, 'Elixir supports group notes.\n\nWhat kind of healthcare organization are you with?');
  // Declined contact or support: nothing is added.
  out = await run({ answer: 'Elixir supports group notes.', nextField: 'size' }, { contactPreference: 'declined' });
  assert.equal(out.answer, 'Elixir supports group notes.');
  out = await run({ answer: 'Please contact your support channel.', nextField: 'size', intent: 'support' });
  assert.equal(out.answer, 'Please contact your support channel.');
  // A visitor's own question is never stored as a qualification fact.
  out = await run({ answer: 'It depends on scoping.', nextField: null, qualification: { timeline: 'How long does implementation usually take?' } }, { messages: [{ role: 'user', content: 'How long does implementation usually take?' }] });
  assert.deepEqual(out.qualification, {});
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('the instructions say when the previous reply already recommended the discovery call', async () => {
  let system = '';
  const handler = createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async (url, options) => { system = JSON.parse(options.body).messages[0].content; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Elixir supports EHR workflows.', citationIds: [] }) } }] })); } });
  await handler({ ...body, messages: [{ role: 'user', content: 'Tell me about your EHR.' }, { role: 'assistant', content: 'You can book a discovery call with the button.' }, { role: 'user', content: 'And billing?' }] });
  assert.match(system, /previous reply already recommended the discovery call/);
  await handler(body);
  assert.doesNotMatch(system, /previous reply already recommended the discovery call/);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('a question already asked earlier in the chat is not asked again; the next unknown one is', async () => {
  const run = async (reply, messages, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', ...reply }) } }] })) })({ ...body, messages, ...extra })).body;
  const asked = [
    { role: 'user', content: 'We run a behavioral health program.' },
    { role: 'assistant', content: 'Elixir supports that.\n\nRoughly how many providers or locations would use Elixir?' },
    { role: 'user', content: 'Do you support group notes in the EHR?' },
  ];
  // The model repeats the ignored size question: it is replaced by the next unknown field's question.
  let out = await run({ answer: 'Yes, group notes are supported.\n\nRoughly how many providers or locations would use Elixir?', nextField: 'size' }, asked);
  assert.equal(out.answer, 'Yes, group notes are supported.\n\nWhat kind of healthcare organization are you with?');
  assert.equal(out.nextField, 'organizationType');
  // Known facts and skipped fields are passed over too.
  out = await run({ answer: 'Yes, group notes are supported.', nextField: 'size' }, asked, { qualification: { organizationType: 'behavioral health program' }, skipped: ['currentSystem'] });
  assert.equal(out.answer, 'Yes, group notes are supported.\n\nDoes your organization already use Salesforce?');
  assert.equal(out.nextField, 'salesforceUsage');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('buying intent and provider-funnel questions always carry one discovery-call sentence before the question', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, nextField: 'size', ...reply }) } }] })) })({ ...body, ...extra })).body;
  const CALL = 'You can book a discovery call with the Elixir team using the “Book a discovery call” button in this chat.';
  let out = await run({ answer: 'Elixir is priced per credentialed provider per month.', intent: 'demo' });
  assert.equal(out.answer, `Elixir is priced per credentialed provider per month. ${CALL}\n\nRoughly how many providers or locations would use Elixir?`);
  out = await run({ answer: 'Elixir routes CYBHI claims from the note.', intent: 'explore' }, { providerType: 'cybhi' });
  assert.match(out.answer, /Book a discovery call/);
  // Already mentioned, ordinary exploring, declined contact, or recommended in the previous reply: nothing added.
  out = await run({ answer: 'Book a discovery call to scope it.', intent: 'demo' });
  assert.equal((out.answer.match(/discovery call/gi) ?? []).length, 1);
  out = await run({ answer: 'Elixir supports group notes.', intent: 'explore' });
  assert.doesNotMatch(out.answer, /discovery call/i);
  out = await run({ answer: 'Elixir is priced per provider.', intent: 'demo' }, { contactPreference: 'declined' });
  assert.doesNotMatch(out.answer, /discovery call/i);
  out = await run({ answer: 'Elixir is priced per provider.', intent: 'demo' }, { messages: [{ role: 'user', content: 'Tell me about your EHR.' }, { role: 'assistant', content: 'You can book a discovery call.' }, { role: 'user', content: 'What does it cost?' }] });
  assert.doesNotMatch(out.answer, /discovery call/i);
});
