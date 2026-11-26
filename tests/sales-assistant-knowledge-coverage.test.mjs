// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Retrieval coverage for the website assistant: every product capability the site describes must be
// reachable from the words a visitor would actually type. Positive questions assert the expected entry
// is in the top 3; negative questions assert that nothing is retrieved for off-topic text, so the
// model falls back to its grounded overview instead of being handed an unrelated product page;
// multi-topic questions assert that both topics come back together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedKnowledge, retrieveKnowledge } from '../api/lib/knowledge.mjs';

const top = (text, n = 3) => retrieveKnowledge([{ role: 'user', content: text }], approvedKnowledge).slice(0, n).map((entry) => entry.id);

const POSITIVE = [
  ['Does Elixir have Group Notes?', 'group-sessions'],
  ['How is Elixir priced and how long does implementation take?', 'pricing-implementation'],
  ['Can you share customer case studies?', 'customer-stories'],
  ['Can we write one group note for a group therapy session and push it to every client?', 'group-sessions'],
  ['How do you track attendance for group sessions in our IOP?', 'group-sessions'],
  ['Do you support group counseling documentation?', 'group-sessions'],
  ['Do you handle prior authorization?', 'prior-authorization'],
  ['Can we track approved units and dates on authorizations from the payer?', 'prior-authorization'],
  ['Do you support utilization review for continued stay?', 'prior-authorization'],
  ['How does insurance eligibility verification work?', 'eligibility-verification'],
  ['Can the front desk verify insurance before the visit and save the VOB?', 'eligibility-verification'],
  ['Can we run bulk eligibility checks for tomorrow’s appointments?', 'eligibility-verification'],
  ['How do you handle claim denials and appeals?', 'denial-management'],
  ['Can it read CARC and RARC codes and tell us the root cause?', 'denial-management'],
  ['Do you submit UB-04 institutional claims as well as CMS-1500?', 'claims-processing'],
  ['What does your claims processing and scrubbing look like?', 'claims-processing'],
  ['Can we generate a superbill?', 'claims-processing'],
  ['How do you close the loop on referrals to outside providers?', 'care-coordination'],
  ['How is consent handled when we share records with community partners?', 'care-coordination'],
  ['Do you support chronic care management billing and CCM time tracking?', 'care-management'],
  ['Can we run transitional care management after a hospital discharge?', 'care-management'],
  ['Do you support the collaborative care model?', 'care-management'],
  ['Can we build treatment plans with goals, objectives and interventions?', 'care-plans'],
  ['Do care plans support e-signatures from patients and guardians?', 'care-plans'],
  ['How do you help with HEDIS and CCBHC quality measures?', 'value-based-care'],
  ['Do you support value-based care contracts?', 'value-based-care'],
  ['Can we screen for social determinants of health like housing and food insecurity?', 'sdoh'],
  ['Do you support PRAPARE screening?', 'sdoh'],
  ['Do you have a call center for admissions and intake inquiries?', 'contact-center'],
  ['Can we see which marketing campaigns lead to admissions?', 'contact-center'],
  ['Can you track bed census across our facilities?', 'contact-center'],
  ['Do you have a FHIR API?', 'interoperability'],
  ['Can Elixir integrate with our lab through HL7?', 'interoperability'],
  ['How do we export patient data out of the system?', 'interoperability'],
  ['Can you predict patient no-shows?', 'no-show-prediction'],
  ['Our missed appointments are high, can you help?', 'no-show-prediction'],
  ['Is there a pre-visit questionnaire patients fill out by text message?', 'visit-prep'],
  ['Do you have an ambient scribe for clinical documentation?', 'ai-clinical-documentation'],
  ['Can clinicians dictate notes with AI?', 'ai-clinical-documentation'],
  ['Can AI help with accounts receivable and collections?', 'ar-agent'],
  ['Can it read payer policy manuals and recommend CPT codes?', 'payer-policy'],
  ['Do you use AI for medical coding?', 'payer-policy'],
  ['Does the AI make decisions on its own or is there human review?', 'responsible-ai'],
  ['Is our patient data used to train your AI models?', 'responsible-ai'],
  ['How does appointment scheduling work?', 'scheduling-intake'],
  ['Can patients do self check-in before arriving?', 'scheduling-intake'],
  ['Can we order labs and see lab result trends?', 'clinical-chart'],
  ['Do you track care episodes?', 'clinical-chart'],
  ['Can we order equipment and consumables from the chart with barcodes?', 'clinical-chart'],
  ['Do you have secure messaging with patients?', 'message-center'],
  ['Do you support multi-factor authentication?', 'security-certification'],
  ['Is Elixir ONC certified?', 'security-certification'],
  ['Are you a member of NAATP?', 'naatp-addiction-providers'],
  ['Do you have a referral program for partners?', 'referral-program'],
  ['Do you support EVV for home care?', 'evv'],
  ['Do you offer a patient portal?', 'patient-portal'],
  ['Will you sign a BAA?', 'hipaa-baa'],
  ['What is Kratu AI?', 'kratu-ai'],
  ['Do you support telehealth video visits?', 'telehealth'],
  ['We run a residential detox program', 'addiction-treatment'],
  ['How much does it cost?', 'discovery-call'],
];

const NEGATIVE = [
  'What is the weather in Paris tomorrow?',
  'Can you recommend a good pizza place nearby?',
  'Write me a poem about the ocean',
  'Who won the football game last night?',
  'asdf qwerty zxcv',
  'Do you sell car parts?',
  'I want to buy a used truck',
  'What is the capital of Australia?',
  'Tell me a joke',
  'How do I bake sourdough bread?',
  'Can you help me with my math homework?',
  'Is Epic better than Cerner?',
  'Do you compare favorably to athenahealth?',
  'We are a restaurant chain looking for point of sale software',
  'Do you sell real estate listings?',
  'Can you fix my laptop keyboard?',
  'What stocks should I buy?',
];

const MULTI = [
  ['Do you handle prior authorization and eligibility verification?', ['prior-authorization', 'eligibility-verification']],
  ['We need group notes and treatment plans with goals', ['group-sessions', 'care-plans']],
  ['Can you predict no-shows and send appointment reminders through scheduling?', ['no-show-prediction', 'scheduling-intake']],
  ['Do you have a FHIR API and are you ONC certified?', ['interoperability', 'security-certification']],
  ['We need denial management and an A/R agent for collections', ['denial-management', 'ar-agent']],
  ['Do you support SDOH screening and care coordination referrals?', ['sdoh', 'care-coordination']],
  ['Ambient scribe plus a pre-visit questionnaire for patients', ['ai-clinical-documentation', 'visit-prep']],
  ['We bill UB-04 claims and need EVV for home care', ['claims-processing', 'evv']],
  ['Do you have secure messaging and a patient portal?', ['message-center', 'patient-portal']],
];

test('every capability question retrieves its entry in the top 3', () => {
  const ids = new Set(approvedKnowledge.map((entry) => entry.id));
  for (const [question, expected] of POSITIVE) {
    assert.ok(ids.has(expected), `unknown expected id ${expected}`);
    assert.ok(top(question).includes(expected), `${JSON.stringify(question)} -> ${JSON.stringify(top(question, 4))}, expected ${expected}`);
  }
  assert.ok(POSITIVE.length >= 40);
});

test('every approved entry is reachable from at least one visitor question', () => {
  const covered = new Set(POSITIVE.map(([, id]) => id));
  for (const entry of approvedKnowledge) if (entry.id !== 'platform-overview') {
    if (!covered.has(entry.id)) assert.ok(['ehr', 'rcm', 'billing-ai', 'behavioral-health', 'treatment-center', 'mental-health', 'caregiver-app', 'salesforce-evv', 'outpatient-clinics', 'small-practices', 'aesthetic-practices', 'student-health-cybhi'].includes(entry.id), `no coverage question for ${entry.id}`);
  }
});

test('off-topic, competitor and nonsense questions retrieve no product entry', () => {
  for (const question of NEGATIVE) assert.deepEqual(top(question, 4), [], JSON.stringify(question));
  assert.ok(NEGATIVE.length >= 15);
});

test('multi-topic questions retrieve both topics', () => {
  for (const [question, expected] of MULTI) {
    const got = retrieveKnowledge([{ role: 'user', content: question }], approvedKnowledge).map((entry) => entry.id);
    for (const id of expected) assert.ok(got.includes(id), `${JSON.stringify(question)} -> ${JSON.stringify(got)}, missing ${id}`);
  }
  assert.ok(MULTI.length >= 8);
});

test('the CEO question about group notes is answered from the group session entry first', () => {
  assert.equal(top('does Elixir have Group Notes?')[0], 'group-sessions');
  const entry = approvedKnowledge.find((item) => item.id === 'group-sessions');
  assert.match(entry.content, /single group note/);
  assert.match(entry.content, /attendance/i);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
// Round-1 live review (2026-11-26): questions the site answers that retrieval missed.
test('published pricing, implementation, customers, labs and data ownership are retrievable', () => {
  const cases = [
    ['How much does Elixir cost per provider per month?', 'pricing-implementation'],
    ['We have 120 employees. How many licenses would we need?', 'pricing-implementation'],
    ['How long does implementation usually take?', 'pricing-implementation'],
    ['Can you migrate our data from our current system?', 'pricing-implementation'],
    ['Which treatment centers use Elixir? Give me some customer names.', 'customer-stories'],
    ['Do you integrate with Quest labs?', 'outpatient-clinics'],
    ['Do you connect with KIPU?', 'contact-center'],
    ['Who owns the data if we leave?', 'interoperability'],
    ['What exactly is Elixir and how is it different from a normal EHR?', 'platform-overview'],
    ['Can Elixir collect PHQ-9 and GAD-7 on a schedule?', 'mental-health'],
  ];
  for (const [question, id] of cases) assert.ok(top(question).includes(id), `${JSON.stringify(question)} -> ${id}, got ${top(question)}`);
});

// AGENT-GENERATED — ORACLE REVIEW NEEDED
test('hyphenated words match and the newest visitor message outweighs earlier ones', () => {
  assert.ok(top('We provide home-health visits with field caregivers. Do you have EVV?').includes('evv'));
  const conversation = [
    { role: 'user', content: 'Hi, we are a 25-clinician outpatient mental health group.' },
    { role: 'assistant', content: 'Thanks. Which EHR do you use today?' },
    { role: 'user', content: 'We use SimplePractice today.' },
    { role: 'assistant', content: 'Got it. What is the main problem?' },
    { role: 'user', content: 'Our biggest pain is insurance denials and slow payments.' },
  ];
  const ids = retrieveKnowledge(conversation, approvedKnowledge).slice(0, 3).map((entry) => entry.id);
  assert.ok(ids.includes('denial-management'), `latest message about denials -> denial-management, got ${ids}`);
});
