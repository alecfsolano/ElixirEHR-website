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
  const plain = reply('ANSWER: Elixir can add revenue cycle to a clinical-only setup. What would you like to know next?');
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
    assert.equal(result.body.answer, 'Elixir can add revenue cycle to a clinical-only setup.\n\nWhat would you like to know next?', name);
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
  const answer = 'Elixir can add revenue cycle to a clinical-only setup. What would you like to know next?';
  const unmarked = 'Yes. Elixir covers behavioral health and home visits on one record.\n\nMany teams start with scheduling, then add billing. Which part matters most to you?';
  const screens = 'The user interface stays the same for clinicians, and revenue cycle is added to it.';
  const telehealth = 'We have a telehealth capability that works with the same patient record.';
  const ordinary = [
    'Yes, Elixir supports telehealth visits.', 'Hi! What kind of care do you provide?', 'Happy to help. What is your timeline? 😊',
    'Thinking about switching from Epic? Elixir can migrate your records in phases.', 'Analysis of denials is built into Elixir billing.',
    'Elixir exchanges lab results as JSON. Which systems do you use?', 'User permissions are set by role. A user has access only to what that role allows.',
    'Should you add sites later, each one can share the same record.', 'Licensing is confirmed by the Elixir team. Which staff roles need access?',
    'Elixir funciona con su equipo. ¿Cuántas sedes tiene?',
  ];
  const quoted = '"Clinical only" setups can add revenue cycle. (Most teams do this in phases.)';
  for (const [content, expected] of [
    [answer, answer], [`  ${answer}\n`, answer], [`Answer: ${answer}`, answer], [`**ANSWER:** ${answer}`, answer], [`**ANSWER**: ${answer}`, answer], [`ANSWER\uFF1A ${answer}`, answer],
    [unmarked, unmarked], [screens, screens], [telehealth, telehealth], [quoted, quoted],
    [`# ANSWER:\n${answer}`, answer], [`ANSWER\n\n${answer}`, answer], [`**ANSWER: ${answer}**`, answer],
    ['Elixir fits, so **what size is your organization?**', 'Elixir fits, so what size is your organization?'],
    // A care-setting question in the model's own words is shown in its canonical wording.
    ...ordinary.map((text) => [text, text === 'Hi! What kind of care do you provide?' ? 'Hi! What kind of healthcare organization are you with?' : text]),
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
  const good = 'Elixir can add revenue cycle to a clinical-only setup. What would you like to know next?';
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
  let out = await run({ answer: 'Elixir supports group notes for each participant.', nextField: 'size' }, { qualification: { organizationType: 'outpatient clinic' } });
  assert.equal(out.answer, 'Elixir supports group notes for each participant.\n\nRoughly how many providers or locations would use Elixir?');
  // A question at the end of the paragraph moves to its own line.
  out = await run({ answer: 'Elixir supports group notes. You can book a discovery call with the button. Which EHR do you use today?', nextField: 'currentSystem' }, { qualification: { organizationType: 'outpatient clinic', size: '20 providers' } });
  assert.equal(out.answer, 'Elixir supports group notes. You can book a discovery call with the Elixir team using the “Book a discovery call” button in this chat.\n\nWhich EHR or practice-management system do you use today?');
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
  let out = await run({ answer: 'Elixir is priced per credentialed provider per month.', intent: 'demo' }, { qualification: { organizationType: 'outpatient clinic' } });
  assert.equal(out.answer, `Elixir is priced per credentialed provider per month. There is no standard price: the Elixir team gives a written quote after scoping. ${CALL}\n\nRoughly how many providers or locations would use Elixir?`);
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

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-3 live review (2026-11-26) guardrails.
test('a field answered in this message is not asked, timelines are not judged, and partners get no buyer question', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge: [...knowledge, { ...knowledge[0], id: 'referral-program', title: 'Elixir referral program for partners', content: 'Approved test fixture: partner referral program for the EHR.' }], clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', ...reply }) } }] })) })({ ...body, ...extra })).body;
  // The visitor named the main problem in this message: Fitz moves on to the next unknown field.
  let out = await run({ answer: 'Elixir handles denials in the EHR.', nextField: 'primaryNeed', qualification: { primaryNeed: 'insurance denials' } }, { messages: [{ role: 'user', content: 'Our biggest pain is insurance denials in our EHR.' }] });
  assert.doesNotMatch(out.answer, /main problem/);
  assert.match(out.answer, /\n\nWhat kind of healthcare organization are you with\?$/);
  // A sentence judging whether the visitor's timeline is realistic is dropped; the rest stays.
  out = await run({ answer: 'Elixir supports EVV in the EHR. Next quarter is a realistic timeline for most agencies. The team scopes the plan with you.', nextField: null });
  assert.equal(out.answer, 'Elixir supports EVV in the EHR. The team scopes the plan with you.');
  out = await run({ answer: 'Six months is a good window for this kind of move. Elixir supports the EHR migration.', nextField: null });
  assert.equal(out.answer, 'Elixir supports the EHR migration. The Elixir team confirms timing during scoping.');
  // A reply about the partner referral program alone does not ask buyer questions.
  out = await run({ answer: 'Partners refer facilities and earn a reward after implementation.', nextField: 'organizationType', citationIds: ['referral-program'] }, { messages: [{ role: 'user', content: 'Do you have a referral program for partners of the EHR?' }] });
  assert.equal(out.answer, 'Partners refer facilities and earn a reward after implementation.');
  assert.equal(out.nextField, null);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-4 live review (2026-11-26) guardrails.
test('finishing rules never cut text, ask the canonical question, add knowledge limits, avoid repeats and redirect creative off-topic requests', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  // Periods inside numbers and versions are not sentence ends: nothing is lost.
  const whole = 'Elixir uses OAuth 2.0 client credentials for its EHR API. The certification number is 15.04.04.3164.Elix.01.00.1.230721.';
  assert.equal((await run({ answer: whole })).answer, whole);
  let out = await run({ answer: 'Elixir uses OAuth 2.0 client credentials. Next quarter is a realistic timeline. The record ID is 15.04.04.3164.Elix.01.00.1.230721.' });
  assert.equal(out.answer, 'Elixir uses OAuth 2.0 client credentials. The record ID is 15.04.04.3164.Elix.01.00.1.230721. The Elixir team confirms timing during scoping.');
  // A reworded closing question becomes the canonical question for the next field.
  out = await run({ answer: 'Elixir supports aesthetic charting in the EHR.\n\nWhat care setting do you run in?', nextField: 'size' }, { qualification: { organizationType: 'outpatient clinic' } });
  assert.equal(out.answer, 'Elixir supports aesthetic charting in the EHR.\n\nRoughly how many providers or locations would use Elixir?');
  // A field asked earlier (in its canonical wording) is not asked again, however the model words it.
  const earlier = [{ role: 'user', content: 'We run a home care agency on an EHR.' }, { role: 'assistant', content: 'Elixir supports home care.\n\nWhich EHR or practice-management system do you use today?' }];
  out = await run({ answer: 'Elixir verifies visits in the EHR.\n\nWhich EHR or billing system do you use today?', nextField: 'currentSystem' }, { qualification: { organizationType: 'home care agency', size: '40 caregivers' }, messages: [...earlier, { role: 'user', content: 'How does EVV work in the EHR?' }] });
  assert.match(out.answer, /\n\nDoes your organization already use Salesforce\?$/);
  assert.equal((out.answer.match(/\?/g) ?? []).length, 1);
  // A limit the knowledge attaches to a fact is added once, and not when already there.
  out = await run({ answer: 'Elixir supports Part 2 consent in the EHR.' });
  assert.equal(out.answer, 'Elixir supports Part 2 consent in the EHR. Applicable Part 2 requirements should be confirmed with your privacy reviewer.');
  out = await run({ answer: 'Elixir routes EHR visit data through EVV aggregator connectors. Connector availability is confirmed for the specific payer and state implementation.' });
  assert.equal(out.answer, 'Elixir routes EHR visit data through EVV aggregator connectors. Connector availability is confirmed for the specific payer and state implementation.');
  // A sentence that restates an earlier reply is dropped; with nothing new left, Fitz says so plainly.
  const exported = 'Elixir supports exporting electronic health information for a single patient or a patient population.';
  out = await run({ answer: `Understood. ${exported}` }, { contactPreference: 'declined', messages: [{ role: 'user', content: 'Who owns the EHR data?' }, { role: 'assistant', content: exported }, { role: 'user', content: 'I do not want sales. Just answer about the EHR.' }] });
  assert.equal(out.answer, 'Understood. Ask me anything else about Elixir and I’ll answer here.');
  // Buying intent in the visitor's message earns the discovery-call sentence even when the model chose explore.
  out = await run({ answer: 'Typical EHR go-live is scoped with the team.' }, { messages: [{ role: 'user', content: 'How long does EHR implementation usually take?' }] });
  assert.match(out.answer, /discovery call/);
  // A poem instead of an Elixir answer is replaced by the redirect.
  out = await run({ answer: 'Soft paws cross the floor,\nA whiskered shadow once more.\nGold eyes glow at night,\nGuarding dreams till light.' }, { messages: [{ role: 'user', content: 'Write me a poem about cats and the EHR.' }] });
  assert.match(out.answer, /^I can only help with questions about Elixir/);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-5 live review (2026-11-26) guardrails.
test('limits go before the booking sentence, repeats never leave a dangling sentence, and source talk is removed', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  // "Workable" judges the timeline too.
  let out = await run({ answer: 'Switching by next quarter may be workable. Elixir scopes the EHR plan with the team.' });
  assert.equal(out.answer, 'Elixir scopes the EHR plan with the team.');
  // A missing limit is placed before a closing booking sentence, not after it.
  out = await run({ answer: 'Typical EHR go-live is 6 to 10 weeks from kick-off. You can book a discovery call with the Elixir team.' });
  assert.equal(out.answer, 'Typical EHR go-live is 6 to 10 weeks from kick-off. That typical go-live assumes a small practice on a standard configuration; larger or multi-program organizations have their timeline scoped with the team. You can book a discovery call with the Elixir team.');
  // Routing visit data carries the connector limit.
  out = await run({ answer: 'Elixir routes EHR visit data to the system your state requires.' });
  assert.equal(out.answer, 'Elixir routes EHR visit data to the system your state requires. Connector availability is confirmed for your specific payer and state.');
  // A repeated sentence stays when the next one leans on it, and booking sentences are left to their own rule.
  const earlier = 'Use the Book a discovery call button so the Elixir team can review your EHR setup.';
  const point = 'Elixir keeps intake, notes and claims for the EHR on one Salesforce record.';
  out = await run({ answer: `${point} They also share one patient timeline.` }, { messages: [{ role: 'user', content: 'Tell me about the EHR.' }, { role: 'assistant', content: point }, { role: 'user', content: 'And the EHR timeline?' }] });
  assert.equal(out.answer, `${point} They also share one patient timeline.`);
  out = await run({ answer: `${earlier} The team reviews pricing on the call.` }, { messages: [{ role: 'user', content: 'Tell me about the EHR.' }, { role: 'assistant', content: earlier }, { role: 'user', content: 'How do I set up an EHR call?' }] });
  assert.equal(out.answer, `You can book a discovery call with the Elixir team using the “Book a discovery call” button in this chat. The team reviews pricing on the call.`);
  // The answer never talks about what its information includes.
  out = await run({ answer: 'The EHR certification record is published on the Elixir Certified Module page, but that list is not included here.' });
  assert.equal(out.answer, 'The EHR certification record is published on the Elixir Certified Module page.');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-6 live review (2026-11-26) guardrails.
test('replies in another language stay in it, limits are matched by meaning, unsupported judgments go and questions about others are not visitor facts', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  // A Spanish reply keeps its own closing question and gets no English sentences.
  const spanish = 'Sí. Elixir tiene EHR para salud mental con evaluaciones de riesgo y reportes para programas comunitarios.\n\n¿Cuántos proveedores usarían Elixir?';
  let out = await run({ answer: spanish, nextField: 'size', intent: 'demo' }, { messages: [{ role: 'user', content: '¿Elixir funciona para clínicas de salud mental con EHR? ¿Cuánto cuesta?' }] });
  assert.equal(out.answer, spanish);
  // Limits already stated in other words are not added twice; missing ones are added once.
  const connector = 'Elixir routes EHR visit data through a connector framework. Availability for your Ohio setup is confirmed with the team for the specific payer and state.';
  assert.equal((await run({ answer: connector })).answer, connector);
  out = await run({ answer: 'Elixir is backed by a SOC 2 Type II report shared under NDA for the EHR.' });
  assert.equal(out.answer, 'Elixir is backed by a SOC 2 Type II report shared under NDA for the EHR. The SOC 2 Type II report belongs to Mirketa, which develops and operates Elixir, and is shared under a non-disclosure agreement.');
  out = await run({ answer: 'Elixir can provide an executed BAA for its EHR work.' });
  assert.equal(out.answer, 'Elixir can provide an executed BAA for its EHR work. The BAA covering the platform services is between your organization and the platform provider.');
  // A fit or usage claim the knowledge never makes is dropped when real content remains.
  out = await run({ answer: 'That sounds like a fit for Elixir. Elixir keeps EHR intake, notes and claims on one record.' });
  assert.equal(out.answer, 'Elixir keeps EHR intake, notes and claims on one record.');
  // "Value-based contracts" is not buying intent.
  out = await run({ answer: 'Elixir tracks EHR quality measures for value-based care.' }, { messages: [{ role: 'user', content: 'We are moving into value-based contracts. What EHR quality measure support do you have?' }] });
  assert.doesNotMatch(out.answer, /discovery call/);
  // "Which treatment centers use Elixir?" is about other organizations, not the visitor's own type.
  out = await run({ answer: 'Elixir has published EHR customer stories.', qualification: { organizationType: 'treatment centers' } }, { messages: [{ role: 'user', content: 'Which treatment centers use Elixir? Give me some EHR customer names.' }] });
  assert.deepEqual(out.qualification, {});
  out = await run({ answer: 'Elixir supports residential EHR programs.', qualification: { organizationType: 'residential treatment center' } }, { messages: [{ role: 'user', content: 'We are a residential treatment center. Which EHR features fit us?' }] });
  assert.deepEqual(out.qualification, { organizationType: 'residential treatment center' });
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-7 live review (2026-11-26) guardrails.
test('questions follow the order and are added to knowledge answers, fit claims and same-reply repeats go, and "not named here" talk is removed', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  // The model's pick of a later open field stands (the visitor may have implied the earlier ones).
  let out = await run({ answer: 'Elixir supports group EHR notes.', nextField: 'currentSystem' }, { qualification: { organizationType: 'outpatient clinic' } });
  assert.match(out.answer, /\n\nWhich EHR or practice-management system do you use today\?$/);
  // A reworded booking sentence becomes the standard one.
  out = await run({ answer: 'Elixir supports group EHR notes. Book a discovery call in this chat to review pricing.' });
  assert.equal(out.answer, 'Elixir supports group EHR notes. You can book a discovery call with the Elixir team using the “Book a discovery call” button in this chat.');
  // A knowledge answer left without a question gets the next one; a reply with no sources does not.
  out = await run({ answer: 'Elixir is not affiliated with that EHR association.', citationIds: ['ehr'] });
  assert.match(out.answer, /\n\nWhat kind of healthcare organization are you with\?$/);
  out = await run({ answer: 'I can help with Elixir EHR questions.' });
  assert.equal(out.answer, 'I can help with Elixir EHR questions.');
  // A fit claim the knowledge never makes goes; the substance stays.
  out = await run({ answer: 'Elixir is a good fit for your clinic. Elixir keeps EHR intake, notes and claims on one record.' });
  assert.equal(out.answer, 'Elixir keeps EHR intake, notes and claims on one record.');
  // The same point twice in one reply is said once.
  out = await run({ answer: 'Elixir keeps EHR intake, notes and claims on one record. Elixir keeps intake, notes and claims for the EHR on one record.' });
  assert.equal(out.answer, 'Elixir keeps EHR intake, notes and claims on one record.');
  // Talk about what is not named "here" is removed, as a clause or as a sentence.
  out = await run({ answer: 'Elixir publishes EHR customer stories, but the treatment centers are not named specifically here. Granite Recovery has a published story.' });
  assert.equal(out.answer, 'Elixir publishes EHR customer stories. Granite Recovery has a published story.');
  out = await run({ answer: 'Elixir publishes EHR customer stories. Specific customer types are not listed here.' });
  assert.equal(out.answer, 'Elixir publishes EHR customer stories.');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-8 live review (2026-11-26) guardrails.
test('patient details are never echoed, reworded closing questions map to their field, and source talk and benefit clauses go', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  const phi = { messages: [{ role: 'user', content: 'My patient John Smith, DOB 3/4/1980, member ID 99812, had an EHR claim denied. Can you check why?' }] };
  // The name the visitor typed reads "that patient"; a sentence with the date or ID goes.
  let out = await run({ answer: 'Please do not share patient details here. I can’t check a claim for John Smith, but Elixir tracks EHR denial reasons. Member 99812 should contact support.' }, phi);
  assert.doesNotMatch(out.answer, /John|Smith|99812|3\/4\/1980/);
  assert.match(out.answer, /I can’t check a claim for that patient, but Elixir tracks EHR denial reasons\./);
  // A reworded question about a field already asked moves on to the next open field.
  const asked = [{ role: 'user', content: 'We are an outpatient EHR clinic with 20 providers.' }, { role: 'assistant', content: 'Elixir fits clinics.\n\nWhen are you hoping to make a change?' }, { role: 'user', content: 'What would EHR pricing look like?' }];
  out = await run({ answer: 'Elixir is priced per credentialed provider per month.\n\nWhat timeline are you hoping for?' }, { qualification: { organizationType: 'outpatient clinic', size: '20 providers' }, messages: asked });
  assert.match(out.answer, /\n\nWhich EHR or practice-management system do you use today\?$/);
  // A reworded question about an open field gets the canonical wording.
  out = await run({ answer: 'Elixir supports group EHR notes.\n\nWhat type of care setting do you run?' });
  assert.match(out.answer, /\n\nWhat kind of healthcare organization are you with\?$/);
  // A reply that is only a clarifying question stays as it is.
  out = await run({ answer: 'Do you mean group EHR notes or group billing?' });
  assert.equal(out.answer, 'Do you mean group EHR notes or group billing?');
  // Source talk becomes plain statements or goes; benefit clauses the knowledge never states go.
  out = await run({ answer: 'The site has a published EHR story, but the site does not say which customers are treatment centers. I do not have their names here.' });
  assert.equal(out.answer, 'Elixir has a published EHR story, but Elixir has not published which customers are treatment centers.');
  out = await run({ answer: 'Elixir ties EHR denial work to the remittance record, which helps teams see what is blocking payment.' });
  assert.equal(out.answer, 'Elixir ties EHR denial work to the remittance record.');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-9 live review (2026-11-26) guardrails.
test('drops never leave a dangling or clipped sentence, refusals ask nothing, and merged BAA claims are restated as the knowledge has them', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  // A judgment kept because the next paragraph leans on it.
  let out = await run({ answer: 'Elixir is a strong option for your EHR agency.\n\nThat also keeps visit notes and billing in one workflow.' });
  assert.equal(out.answer, 'Elixir is a strong option for your EHR agency.\n\nThat also keeps visit notes and billing in one workflow.');
  // A dropped timeline verdict takes the sentence leaning on it along.
  out = await run({ answer: 'Elixir supports EHR migration. Next quarter is realistic for you. That also gives your team time. The team scopes the plan.' });
  assert.equal(out.answer, 'Elixir supports EHR migration. The team scopes the plan.');
  // A benefit clause whose removal leaves a fragment takes the whole sentence.
  out = await run({ answer: 'Elixir syncs EHR inquiries with the chart. For residential teams, that helps keep admissions aligned.' });
  assert.equal(out.answer, 'Elixir syncs EHR inquiries with the chart.');
  // A refusal asks no qualifying question.
  out = await run({ answer: 'I can’t help with medication dosing in the EHR chat.\n\nWhat kind of healthcare organization are you with?', nextField: 'organizationType', citationIds: ['ehr'] });
  assert.equal(out.answer, 'I can’t help with medication dosing in the EHR chat.');
  // A sentence merging the two BAAs is restated as two facts, and the limit is not added again.
  out = await run({ answer: 'HIPAA compliance sits with the organization, and Elixir can provide the platform-services BAA for the EHR.' });
  assert.equal(out.answer, 'Elixir signs a BAA covering its own access to protected health information, and the BAA for the platform services is between your organization and the platform provider.');
  // Part 2 phrased as substance use consent still carries the privacy-reviewer limit.
  out = await run({ answer: 'Elixir keeps substance use records in the EHR behind a single consent.' });
  assert.match(out.answer, /confirmed with your privacy reviewer\.$/);
  // "Elixir team" always reads "the Elixir team".
  out = await run({ answer: 'Elixir team confirms EHR migration scope. Pricing is confirmed by Elixir team after scoping.' });
  assert.equal(out.answer, 'The Elixir team confirms EHR migration scope. Pricing is confirmed by the Elixir team after scoping.');
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-10 live review (2026-11-26) guardrails.
test('enough-time verdicts, offers and outcome sentences go, prices carry the quote note, and facts stated in passing are not asked again', async () => {
  const run = async (reply, extra = {}) => (await createChatHandler({ env, knowledge, clientLimiter: { take: () => ({ allowed: true }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ citationIds: [], qualification: {}, intent: 'explore', nextField: null, ...reply }) } }] })) })({ ...body, ...extra })).body;
  let out = await run({ answer: 'Elixir supports EHR admissions. A six-month move is enough time for most teams. The team scopes the plan.' });
  assert.equal(out.answer, 'Elixir supports EHR admissions. The team scopes the plan.');
  out = await run({ answer: 'Elixir keeps EHR claims on one record. That helps teams get to a claim-ready workflow this year. If you want, I can outline the steps.' });
  assert.equal(out.answer, 'Elixir keeps EHR claims on one record.');
  // A visitor who says "for a group of 12 therapists" is not asked their organization type or size.
  out = await run({ answer: 'Elixir schedules PHQ-9 in the EHR.\n\nWhat kind of healthcare organization are you with?', nextField: 'organizationType' }, { messages: [{ role: 'user', content: 'Can the EHR collect PHQ-9 on a schedule, and what would it cost for a group of 12 therapists?' }] });
  assert.match(out.answer, /\n\nWhich EHR or practice-management system do you use today\?$/);
  // "I can only help…" is a refusal: no qualifying question.
  out = await run({ answer: 'I can only help with Elixir EHR questions.\n\nWhat kind of healthcare organization are you with?', nextField: 'organizationType' });
  assert.equal(out.answer, 'I can only help with Elixir EHR questions.');
});
