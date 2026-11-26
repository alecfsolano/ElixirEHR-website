// A scriptable stand-in for the model provider's HTTP API (Groq/Azure chat completions). It is the
// `fetchImpl` handed to the REAL api/lib/chat-handler.mjs, so everything except the model runs:
// validation, retrieval, caps, the retry/plain-text recovery and the reply filters. It never opens
// a network connection, so no model is ever called and nothing is spent.
//
// A scenario script is a function of the call: (call) => outcome | null (null = a good reply).
// `call` = { req, attempt, plain, model, turn, sources, lastUser, pageContext } where `req` is the
// 1-based /api/chat request number on this server, `attempt` is the model attempt within that
// request (1, or 2 for the handler's retry) and `turn` the visitor message count the handler saw.
import { AsyncLocalStorage } from 'node:async_hooks';
import { QUALIFICATION_FIELDS } from '../../api/shared/contract.mjs';

/** Per-/api/chat-request scope, so concurrent requests count their own model attempts. */
export const requestScope = new AsyncLocalStorage();

export const outcome = {
  /** A valid reply: JSON in structured mode, `ANSWER: …` in plain mode. */
  good: (options = {}) => ({ kind: 'good', ...options }),
  /** Raw message content as the provider would return it. */
  content: (content, finish = 'stop') => ({ kind: 'content', content, finish }),
  /** A provider HTTP error. */
  http: (status, body = {}, headers = {}) => ({ kind: 'http', status, body, headers }),
  /** Never answers: the handler's own 20 s timeout ends the call. */
  hang: () => ({ kind: 'hang' }),
  /** A dropped connection. */
  network: () => ({ kind: 'network' }),
  /** Wait, then resolve the next outcome. */
  delay: (ms, then = null) => ({ kind: 'delay', ms, then }),
};

// One distinct point per turn, so the reply rules that drop repeated points never remove a default reply.
const DEFAULT_POINTS = [
  'Elixir brings intake, documentation and billing into one Salesforce-native platform',
  'Scheduling, reminders and patient forms share a single chart',
  'Group sessions record attendance alongside individual progress notes',
  'Eligibility checks happen before each appointment',
  'Care plans track goals, measures and outcomes over time',
  'Secure messaging connects staff with patients between visits',
  'Denied claims return to a worklist with suggested corrections',
  'Telehealth visits open from the same calendar entry',
  'Referral tracking follows consent through every handoff',
  'Supervisors approve notes before claims leave the building',
  'Dashboards show census, caseloads and revenue together',
  'Mobile caregivers capture signatures at the bedside',
  'Authorizations warn staff before approved units run out',
  'Screening questionnaires score automatically for clinicians',
];
export const defaultAnswer = (turn) => `${DEFAULT_POINTS[(turn - 1) % DEFAULT_POINTS.length]}, reply ${turn}.`;

function parseSources(system) {
  const line = system.split('\n').find((text) => text.startsWith('Knowledge data: '));
  try { return JSON.parse(line.slice('Knowledge data: '.length)); } catch { return []; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function completion(content, finish = 'stop') {
  return new Response(JSON.stringify({ id: 'e2e', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

export function createFakeModel({ getScript, record = () => {} }) {
  return async function fakeModelFetch(url, init = {}) {
    const scope = requestScope.getStore() ?? { req: 0, attempt: 0 };
    scope.attempt += 1;
    const body = JSON.parse(init.body);
    const system = body.messages?.[0]?.content ?? '';
    const sources = parseSources(system);
    const call = {
      req: scope.req,
      attempt: scope.attempt,
      plain: !body.response_format,
      model: body.model,
      turn: Number(/Visitor messages so far: (\d+)\./.exec(system)?.[1] ?? 0),
      sources,
      lastUser: body.messages.at(-1)?.content ?? '',
      pageContext: /Page context \(.*?\): (.*?)\. Starting page path/.exec(system)?.[1] ?? null,
      contactPreference: /Contact preference: (\w+)\./.exec(system)?.[1] ?? null,
    };
    record({
      stage: 'model-request', req: call.req, attempt: call.attempt, url, model: body.model, plain: call.plain,
      responseFormat: body.response_format?.type ?? null, systemChars: system.length, sourceIds: sources.map((source) => source.id),
      pageContext: call.pageContext, contactPreference: call.contactPreference, messages: body.messages.slice(1),
    });
    const respond = async (spec) => {
      const value = spec ?? outcome.good();
      switch (value.kind) {
        case 'delay': await sleep(value.ms); return respond(value.then);
        case 'hang':
          record({ stage: 'model-output', req: call.req, attempt: call.attempt, kind: 'hang' });
          return new Promise((resolve, reject) => {
            const signal = init.signal;
            if (!signal) return;
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        case 'network':
          record({ stage: 'model-output', req: call.req, attempt: call.attempt, kind: 'network' });
          throw new TypeError('fetch failed');
        case 'http':
          record({ stage: 'model-output', req: call.req, attempt: call.attempt, kind: 'http', status: value.status, body: value.body, headers: value.headers });
          return new Response(JSON.stringify(value.body), { status: value.status, headers: { 'content-type': 'application/json', ...value.headers } });
        case 'content':
          record({ stage: 'model-output', req: call.req, attempt: call.attempt, kind: 'content', content: value.content, finish: value.finish });
          return completion(value.content, value.finish);
        case 'good': {
          const answer = value.answer ?? defaultAnswer(call.turn);
          const content = call.plain ? `ANSWER: ${answer}` : JSON.stringify({
            answer,
            citationIds: value.citations === false ? [] : (value.citationIds ?? sources.slice(0, 1).map((source) => source.id)),
            qualification: { ...Object.fromEntries(Object.keys(QUALIFICATION_FIELDS).map((field) => [field, null])), ...value.qualification },
            nextField: value.nextField ?? null,
            intent: value.intent ?? 'explore',
          });
          record({ stage: 'model-output', req: call.req, attempt: call.attempt, kind: 'good', content });
          return completion(content);
        }
        default: throw new Error(`Unknown fake outcome ${value.kind}`);
      }
    };
    return respond(getScript()(call));
  };
}
