import { validateChatRequest } from '../shared/contract.mjs';
import { approvedKnowledge, fallbackKnowledge, retrieveKnowledge } from './knowledge.mjs';
import { reviewKnowledge } from './review-knowledge.mjs';
import { createHostedModel, ModelRateLimitError } from './hosted-model.mjs';
import { clientAddress, clientAddressSource, createClientLimiter } from './client-limit.mjs';

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (status, code, error) => ({ status, headers, body: { code, error } });

export const GROQ_DAILY_CAP = 100;
export const DEFAULT_DAILY_CAP = 300;
// Per-worker admission limits. Groq's are lower because its free allowance is shared with other
// demos; a rate-limited model hands the turn to a fallback model (hosted-model.mjs).
const GROQ_PER_MINUTE = 10;
const GROQ_CONCURRENT = 3;
const AZURE_PER_MINUTE = 30;
const AZURE_CONCURRENT = 4;
const CONCURRENT_RETRY_SECONDS = 3;

/** The most model calls one worker admits per day for the configured provider. */
export function workerDailyCap(env = {}) {
  if (env.ASSISTANT_PROVIDER === 'groq') return GROQ_DAILY_CAP;
  const configured = String(env.ASSISTANT_AZURE_DAILY_CAP ?? '').trim();
  const value = /^\d+$/.test(configured) ? Number.parseInt(configured, 10) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DAILY_CAP;
}

export function createChatHandler({ env = process.env, fetchImpl = fetch, knowledge, clientLimiter = createClientLimiter() } = {}) {
  const review = env.ASSISTANT_KNOWLEDGE_MODE === 'review' && env.ASSISTANT_REVIEW_ENVIRONMENT === 'latest';
  const entries = knowledge ?? (review ? reviewKnowledge : approvedKnowledge);
  const addressSource = clientAddressSource(env.ASSISTANT_CLIENT_ADDRESS_SOURCE);
  // Every provider has a per-worker daily cap: Groq's free tier is fixed at 100; other providers
  // (Azure) use ASSISTANT_AZURE_DAILY_CAP, a positive whole number, default 300.
  const dailyCap = workerDailyCap(env);
  let windowStart = Date.now();
  let dayStart = Date.now();
  let admissions = 0;
  let dailyAdmissions = 0;
  let inFlight = 0;
  // When Groq only backs up another provider, its turns still count against Groq's own budget.
  const groqBackup = env.ASSISTANT_PROVIDER !== 'groq';
  let groqWindowStart = Date.now();
  let groqDayStart = Date.now();
  let groqMinute = 0;
  let groqDay = 0;
  const allowProvider = (name) => {
    if (name !== 'groq' || !groqBackup) return true;
    if (Date.now() - groqWindowStart >= 60000) { groqWindowStart = Date.now(); groqMinute = 0; }
    if (Date.now() - groqDayStart >= 86400000) { groqDayStart = Date.now(); groqDay = 0; }
    return groqMinute < GROQ_PER_MINUTE && groqDay < GROQ_DAILY_CAP;
  };
  const onProviderUsed = (name) => { if (name === 'groq' && groqBackup) { groqMinute++; groqDay++; } };
  // `context.headers` carries the incoming request headers; visitor text is never logged.
  return async (body, context = {}) => {
    if (env.ASSISTANT_ENABLED !== 'true') return failure(503, 'ASSISTANT_UNAVAILABLE', 'The assistant is not available yet. You can still use Contact Us.');
    let request;
    try {
      if (JSON.stringify(body).length > 32000) return failure(413, 'MESSAGE_TOO_LARGE', 'Please shorten your message and try again.');
      request = validateChatRequest(body);
    } catch { return failure(400, 'INVALID_MESSAGE', 'Please shorten your message or start a new conversation.'); }
    let model;
    try { model = createHostedModel({ env, fetchImpl }); }
    catch { return failure(503, 'ASSISTANT_UNAVAILABLE', 'The assistant is temporarily unavailable. Please try Contact Us.'); }
    if (!entries.some((entry) => entry.status === 'approved' || (review && entry.status === 'draft'))) return failure(503, 'KNOWLEDGE_NOT_READY', 'Reviewed product information is not available yet. Please use Contact Us.');
    const sources = retrieveKnowledge(request.messages, entries, { review, providerType: request.providerType });
    // A small grounded context keeps greetings and qualification-only turns conversational.
    if (!sources.length && knowledge === undefined) sources.push(...(review ? [reviewKnowledge[0]] : fallbackKnowledge(entries, { providerType: request.providerType })));
    if (!sources.length) return { status: 200, headers, body: { answer: 'I don’t have reviewed information to answer that question. You can ask about another topic or request a conversation with our team.', citations: [], qualification: {}, nextField: null, intent: 'explore' } };
    // Coarse, per-worker protection only; deployment-level distributed abuse controls are a release gate.
    // Checked before the per-client limit, so a call the worker turns away does not use up the visitor's allowance.
    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); admissions = 0; }
    if (Date.now() - dayStart >= 86400000) { dayStart = Date.now(); dailyAdmissions = 0; }
    const groq = env.ASSISTANT_PROVIDER === 'groq';
    const dailyFull = dailyAdmissions >= dailyCap;
    const busy = dailyFull ? 'day' : inFlight >= (groq ? GROQ_CONCURRENT : AZURE_CONCURRENT) ? 'concurrent' : admissions >= (groq ? GROQ_PER_MINUTE : AZURE_PER_MINUTE) ? 'minute' : null;
    if (busy) {
      // A short, honest wait lets the page wait it out instead of showing an error.
      const retryAfter = busy === 'day' ? 3600 : busy === 'concurrent' ? CONCURRENT_RETRY_SECONDS : Math.max(1, Math.ceil((windowStart + 60000 - Date.now()) / 1000));
      return { ...failure(429, 'PLEASE_WAIT', 'The assistant is busy. Please wait a moment and try again.'), headers: { ...headers, 'Retry-After': String(retryAfter) } };
    }
    const perClient = clientLimiter.take(clientAddress(context.headers, { source: addressSource }));
    if (!perClient.allowed) return { ...failure(429, 'PLEASE_WAIT', 'You have reached the assistant’s message limit for now. You can book a discovery call on our Contact Us page.'), headers: { ...headers, 'Retry-After': perClient.retryAfter } };
    admissions++; dailyAdmissions++; inFlight++;
    // Safe reason codes only (see ModelAttemptError): the site keeps no server logs, so the response
    // says why a first attempt failed and whether the second one recovered it.
    const failedAttempts = [];
    const diagnostic = (name) => (failedAttempts.length ? { ...headers, [name]: failedAttempts.join(',') } : headers);
    let answeredBy = 'primary';
    try {
      const reply = await model.complete(request, sources, { onAttemptFailed: (reason) => failedAttempts.push(reason), onModel: (label) => { answeredBy = label; }, allowProvider, onProviderUsed });
      return { status: 200, headers: { ...diagnostic('X-Assistant-Recovered'), 'X-Assistant-Model': answeredBy }, body: reply };
    }
    catch (error) {
      if (error instanceof ModelRateLimitError) return { ...failure(429, 'PLEASE_WAIT', 'The assistant has reached its request limit. Please wait and try again.'), headers: { ...headers, 'Retry-After': error.retryAfter } };
      return { ...failure(503, 'ASSISTANT_UNAVAILABLE', 'I couldn’t get a reply just now. Please try again or use Contact Us.'), headers: diagnostic('X-Assistant-Failed') };
    }
    finally { inFlight--; }
  };
}
