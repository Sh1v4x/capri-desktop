import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor, buildPrompt, modelList, parseReply, streamEvents } from '../src/translate.mjs';

const TOOLS = [{ type: 'function', function: { name: 'open_app', description: 'Opens an app', parameters: { type: 'object', properties: { name: { type: 'string' } } } } }];

test('model ids map to Claude Code aliases', () => {
  assert.equal(aliasFor('claude-opus', 'sonnet'), 'opus');
  assert.equal(aliasFor('capri', 'sonnet'), 'sonnet');
  assert.equal(aliasFor(undefined, 'haiku'), 'haiku');
  assert.equal(aliasFor('claude-sonnet-5-5', 'sonnet'), 'claude-sonnet-5-5');
  assert.equal(modelList('haiku').data[0].id, 'claude-haiku');
});

test('a single user message goes through as it is, with system prompts joined', () => {
  const { system, content } = buildPrompt({ messages: [{ role: 'system', content: 'You are Capri.' }, { role: 'user', content: 'Hi!' }] });
  assert.equal(system, 'You are Capri.');
  assert.deepEqual(content, [{ type: 'text', text: 'Hi!' }]);
});

test('history becomes a transcript and pictures become image blocks', () => {
  const { content } = buildPrompt({
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer', tool_calls: [{ function: { name: 'open_app', arguments: '{"name":"Spotify"}' } }] },
      { role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] },
    ],
  });
  assert.equal(content.length, 2);
  assert.match(content[0].text, /<history>\n<user>\nfirst\n<\/user>\n<assistant>answer\n<tool_calls>\[\{"name":"open_app","arguments":\{"name":"Spotify"\}\}\]<\/tool_calls><\/assistant>\n<\/history>\nNow reply to this message:\nwhat is this\?/);
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
});

test('Ollama-style images are understood', () => {
  const { content } = buildPrompt({ messages: [{ role: 'user', content: 'look', images: ['iVBORxyz'] }] });
  assert.equal(content[1].source.media_type, 'image/png');
});

test('tools are described in the system prompt', () => {
  const { system } = buildPrompt({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
  assert.match(system, /# Tools/);
  assert.match(system, /"name":"open_app"/);
});

test('tool calls are read back out of the reply', () => {
  const { content, calls } = parseReply('Opening it now.\n<tool_calls>[{"name":"open_app","arguments":{"name":"Spotify"}},{"name":"rm_rf","arguments":{}}]</tool_calls>', TOOLS);
  assert.equal(content, 'Opening it now.');
  assert.equal(calls.length, 1, 'tools that were not offered are dropped');
  assert.equal(calls[0].function.name, 'open_app');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { name: 'Spotify' });
});

test('a reply with no tools offered is left alone', () => {
  const text = 'I said <tool_calls>[]</tool_calls> for fun';
  assert.deepEqual(parseReply(text, undefined), { content: text, calls: [] });
});

test('a broken tool block keeps the whole text instead of losing it', () => {
  const { content, calls } = parseReply('Sure <tool_calls>[{oops', TOOLS);
  assert.equal(calls.length, 0);
  assert.equal(content, 'Sure <tool_calls>[{oops');
});

test('stream events end with a finish reason and [DONE]', () => {
  const sse = streamEvents({ id: 'x', model: 'm', content: 'hey', calls: [] });
  assert.match(sse, /"content":"hey"/);
  assert.match(sse, /"finish_reason":"stop"/);
  assert.ok(sse.endsWith('data: [DONE]\n\n'));
});
