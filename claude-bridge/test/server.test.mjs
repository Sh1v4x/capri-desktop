// Starts the real server with a fake `claude` and talks to it over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const servers = [];

async function start(port, extraEnv = {}) {
  const child = spawn(process.execPath, [join(here, '..', 'server.mjs')], {
    env: { ...process.env, CAPRI_BRIDGE_PORT: String(port), CLAUDE_BIN: join(here, 'fake-claude.mjs'), ANTHROPIC_API_KEY: 'sk-ant-should-not-leak', CLAUDECODE: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('bridge on')) resolve(); });
    child.on('exit', (code) => reject(new Error('server exited ' + code)));
  });
  return `http://127.0.0.1:${port}`;
}

const post = (url, body, headers = {}) => fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

let base;
before(async () => { base = await start(47471); });
after(() => { for (const s of servers) s.kill(); });

test('lists models', async () => {
  const res = await fetch(base + '/v1/models');
  const body = await res.json();
  assert.deepEqual(body.data.map((m) => m.id), ['claude-sonnet', 'claude-opus', 'claude-haiku']);
});

test('runs claude isolated, on the subscription, with the right flags', async () => {
  const res = await post(base, { model: 'claude-haiku', messages: [{ role: 'system', content: 'You are Capri.' }, { role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  const echoed = JSON.parse(body.choices[0].message.content.slice(5));
  const args = echoed.args;
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'You are Capri.');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(echoed.env.ANTHROPIC_API_KEY, null, 'an API key must not reach claude');
  assert.equal(echoed.env.CLAUDECODE, null);
  assert.match(echoed.cwd, /capri-claude-bridge$/);
  assert.equal(body.choices[0].finish_reason, 'stop');
});

test('returns tool calls in OpenAI form, streamed or not', async () => {
  const tools = [{ type: 'function', function: { name: 'open_app', parameters: { type: 'object' } } }];
  const url = await start(47472, { FAKE_CLAUDE_REPLY: 'On it.<tool_calls>[{"name":"open_app","arguments":{"name":"Spotify"}}]</tool_calls>' });
  const plain = await (await post(url, { messages: [{ role: 'user', content: 'play music' }], tools })).json();
  assert.equal(plain.choices[0].message.content, 'On it.');
  assert.equal(plain.choices[0].message.tool_calls[0].function.arguments, '{"name":"Spotify"}');
  assert.equal(plain.choices[0].finish_reason, 'tool_calls');

  const streamed = await post(url, { messages: [{ role: 'user', content: 'play music' }], tools, stream: true });
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
  const text = await streamed.text();
  assert.match(text, /"tool_calls":\[\{"index":0/);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
});

test('answers as soon as the result arrives, even if claude lingers', async () => {
  const url = await start(47476, { FAKE_CLAUDE_REPLY: 'quick', FAKE_CLAUDE_LINGER: '1', CAPRI_BRIDGE_TIMEOUT_MS: '5000' });
  const started = Date.now();
  const res = await post(url, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).choices[0].message.content, 'quick');
  assert.ok(Date.now() - started < 3000);
});

test('a plan limit comes back as 429 with a readable message', async () => {
  const url = await start(47473, { FAKE_CLAUDE_FAIL: "You've hit your usage limit · resets 3pm" });
  const res = await post(url, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /usage limit/);
});

test('a missing claude binary is explained', async () => {
  const url = await start(47474, { CLAUDE_BIN: '/nope/claude' });
  const res = await post(url, { messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error.message, /isn't installed/);
});

test('the optional token is enforced', async () => {
  const url = await start(47475, { CAPRI_BRIDGE_TOKEN: 'secret' });
  assert.equal((await fetch(url + '/v1/models')).status, 401);
  assert.equal((await fetch(url + '/v1/models', { headers: { Authorization: 'Bearer secret' } })).status, 200);
});
