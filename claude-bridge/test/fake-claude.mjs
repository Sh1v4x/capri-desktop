#!/usr/bin/env node
// Stands in for `claude -p` in tests: echoes what it was given as a stream-json result.
// FAKE_CLAUDE_REPLY sets the answer, FAKE_CLAUDE_FAIL makes it fail like Claude Code does.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const turn = JSON.parse(input.trim());
  const record = { args, content: turn.message.content, env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null }, cwd: process.cwd() };
  if (process.env.FAKE_CLAUDE_FAIL) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: process.env.FAKE_CLAUDE_FAIL }));
    return;
  }
  const reply = process.env.FAKE_CLAUDE_REPLY ?? 'ECHO ' + JSON.stringify(record);
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply, usage: { input_tokens: 3, output_tokens: 4 } }));
  // Like the real Claude Code sometimes does, stay alive after the result.
  if (process.env.FAKE_CLAUDE_LINGER) setInterval(() => {}, 1000);
});
