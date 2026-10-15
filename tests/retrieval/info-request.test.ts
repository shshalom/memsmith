import { describe, it, expect } from 'bun:test';
import { classifyPrompt, isInfoRequest, type PromptKind } from '../../src/services/retrieval/info-request.js';

const CASES: Array<[string, PromptKind]> = [
  // Past work, decisions, rationale, history.
  ['why did we switch the queue engine to inline?', 'info-request'],
  ['What did we decide about the embedder model?', 'info-request'],
  ['what was the rationale for the consult window', 'info-request'],
  ['How did we fix the Ollama restart loop?', 'info-request'],
  ['how was the settings.json permission bug fixed', 'info-request'],
  ['when did we drop the SQLite worker?', 'info-request'],
  ['what changed in the hook templates last week', 'info-request'],
  ['who changed the default enforcement mode', 'info-request'],
  ['what did Dana do on the installer branch?', 'info-request'],
  ['what was agreed about team mode pricing', 'info-request'],
  ['have we ever tried pgvector HNSW indexes?', 'info-request'],
  // Configuration and location.
  ['where is the local Postgres port configured?', 'info-request'],
  ['where do we set the retrieval timeout', 'info-request'],
  // Status of prior work.
  ["what's the status of the marketplace cleanup", 'info-request'],
  ['where are we with the migration replay work', 'info-request'],
  // Imperative phrasings of an information request.
  ['remind me how the discovery gate decides to block', 'info-request'],
  ['Tell me about the July enforcement revert', 'info-request'],
  ['tell me why the topic key drops short terms', 'info-request'],
  ['explain why we pinned the embedded PG port', 'info-request'],
  ['give me the history of the record-intent backstop', 'info-request'],
  ['do you remember what broke the codex hooks', 'info-request'],
  // Mixed task + question: the question wins (strict).
  ['fix the flaky test — why did it start failing?', 'info-request'],
  // No retrieval signal: memory-first for these is the agent's own step (the
  // standing directive) and the tool-intent gate, not a prompt-time directive.
  ['is the build passing on main?', 'task'],
  ['how do I run the server tests', 'task'],
  ['what does this function do?', 'task'],
  ['status?', 'task'],
  ['why?', 'task'],
  ['is it working?', 'task'],
  ['what now?', 'task'],
  ['how is it going?', 'task'],
  // A clear retrieval signal still triggers, however short.
  ['status of the npm publish?', 'info-request'],
  ['why did the trusted publisher fail?', 'info-request'],
  ['where is the retrieval timeout configured?', 'info-request'],
  ["what's the reason for the fixed Postgres port?", 'info-request'],

  // Imperative past-work requests: the past-work signal beats the task verb.
  ['summarize what we did last week on the gate', 'info-request'],
  ['list the decisions we made on auth', 'info-request'],
  ['show the history of the discovery gate', 'info-request'],
  ['describe how we fixed the WAL bug', 'info-request'],
  ['give me a recap of last week', 'info-request'],
  ['catch me up on the installer work', 'info-request'],
  ['check what Sam did on the migration', 'info-request'],
  ['recap', 'info-request'],
  ['fix the bug we hit yesterday', 'info-request'],
  // "above" as a value, not a reference to the conversation.
  ['Why did we choose a port above 30000?', 'info-request'],
  // Longer prompts need a past-work signal; a question mark alone is not one.
  ['The login page crashes when I click submit. Can you figure out why?', 'task'],
  ['The importer drops rows with a null project id. Write a failing test first, then fix it. Does that sound right?', 'task'],
  ['Here is the plan for the release. Bump the version, rebuild the bundles, and update the changelog. ' +
    'Then open a PR against main with a summary of the changes and the test results, and tag the reviewers ' +
    'who own the hooks and the installer so they can look at it before the end of the day. Any questions?', 'task'],
  ['The gate blocked a grep again. What did we decide about the consult window?', 'info-request'],
  ['I am picking the installer back up after a break. It has been a while. Where did we leave the Ollama setup last week?', 'info-request'],
  ['The queue engine is inline now. Why was BullMQ dropped? I want to write it up.', 'info-request'],

  // Current-conversation exemptions.
  ['you just said the port is 55433 — why?', 'conversation'],
  ['can you expand on the second point above?', 'conversation'],
  ['as above, but for the codex hooks', 'conversation'],
  ['what about the options you listed above', 'conversation'],
  ['what did you mean earlier in this chat about rule A?', 'conversation'],
  ['why does the plan you wrote skip phase 3?', 'conversation'],
  ['summarize your last answer', 'conversation'],
  ['What did you say about the gate in your previous message?', 'conversation'],

  // Pure task instructions.
  ['fix the failing broker test', 'task'],
  ['add a test for the enforcement status command', 'task'],
  ['run bun test tests/retrieval', 'task'],
  ['Please rename the topic store file', 'task'],
  ['can you add a CHANGELOG entry?', 'task'],
  ["let's refactor the adapter", 'task'],
  ['commit this and push', 'task'],
  ['tell me when the build finishes', 'task'],
  ['yes', 'task'],
  ['ok go ahead', 'task'],
  ['/ms-dashboard', 'task'],
  ['', 'task'],
  ['   ', 'task'],
];

describe('classifyPrompt', () => {
  for (const [prompt, expected] of CASES) {
    it(`${JSON.stringify(prompt)} → ${expected}`, () => {
      expect(classifyPrompt(prompt)).toBe(expected);
    });
  }

  it('ignores injected system-reminder blocks when classifying', () => {
    const prompt = '<system-reminder>why did we do this? remind me</system-reminder>fix the lint errors';
    expect(classifyPrompt(prompt)).toBe('task');
  });

  it('never throws on non-string input', () => {
    expect(classifyPrompt(undefined as unknown as string)).toBe('task');
    expect(classifyPrompt(42 as unknown as string)).toBe('task');
  });
});

describe('isInfoRequest', () => {
  it('is true only for info-request', () => {
    expect(isInfoRequest('why did we pick Bun?')).toBe(true);
    expect(isInfoRequest('you just said Bun — why?')).toBe(false);
    expect(isInfoRequest('run the tests')).toBe(false);
  });
});
