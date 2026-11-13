#!/usr/bin/env node
// Capri's Claude Code bridge: a local, OpenAI-compatible server that answers with
// `claude -p`, so Capri thinks on your Claude subscription instead of an API key.
import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { aliasFor, buildPrompt, completion, modelList, parseReply, streamEvents } from './src/translate.mjs';
import { ClaudeError, runClaude, stopAll } from './src/claude.mjs';

const config = {
  host: process.env.CAPRI_BRIDGE_HOST || '127.0.0.1',
  port: Number(process.env.CAPRI_BRIDGE_PORT || 4747),
  bin: process.env.CLAUDE_BIN || 'claude',
  model: process.env.CAPRI_BRIDGE_MODEL || 'sonnet',
  effort: process.env.CAPRI_BRIDGE_EFFORT ?? 'low',
  token: process.env.CAPRI_BRIDGE_TOKEN || '',
  maxConcurrent: Math.max(1, Number(process.env.CAPRI_BRIDGE_MAX_CONCURRENT || 2)),
  // Capri gives a local server 180 seconds, so the bridge gives up a little sooner.
  timeoutMs: Number(process.env.CAPRI_BRIDGE_TIMEOUT_MS || 170000),
  maxBodyBytes: 50 * 1024 * 1024,
  debug: Boolean(process.env.CAPRI_BRIDGE_DEBUG),
};

// Only a few turns run at once, so a burst of glances can't eat your plan's limits.
let running = 0;
const waiting = [];
async function slot() {
  if (running < config.maxConcurrent) { running++; return; }
  await new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

function send(res, status, body) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res, status, message, type = 'bridge_error') {
  send(res, status, { error: { message, type, code: status } });
}

function authorized(req) {
  if (!config.token) return true;
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(config.token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.maxBodyBytes) { reject(new ClaudeError('The request is too big.', 413)); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new ClaudeError('The request body is not valid JSON.', 400)); }
    });
    req.on('error', reject);
  });
}

async function chat(req, res) {
  const body = await readBody(req);
  const alias = aliasFor(body.model, config.model);
  const { system, content } = buildPrompt(body);
  if (config.debug) console.log('[debug] system:\n' + system + '\n[debug] turn:\n' + JSON.stringify(content, (k, v) => (k === 'data' ? `<${v.length} bytes>` : v), 2));

  // A client that hangs up stops its Claude turn, so a cancelled reply costs nothing more.
  const cancel = new AbortController();
  res.on('close', () => { if (!res.writableFinished) cancel.abort(); });

  const started = Date.now();
  await slot();
  let answer;
  try {
    if (cancel.signal.aborted) return;
    answer = await runClaude({ bin: config.bin, model: alias, system, content, effort: config.effort, timeoutMs: config.timeoutMs, signal: cancel.signal });
  } finally {
    release();
  }

  const { content: text, calls } = parseReply(answer.text, body.tools);
  const id = 'chatcmpl-' + randomUUID();
  const model = body.model || alias;
  const usage = {
    prompt_tokens: (answer.usage.input_tokens || 0) + (answer.usage.cache_read_input_tokens || 0) + (answer.usage.cache_creation_input_tokens || 0),
    completion_tokens: answer.usage.output_tokens || 0,
  };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const images = content.filter((b) => b.type === 'image').length;
  console.log(`${new Date().toISOString()} ${alias} ${Date.now() - started}ms in=${usage.prompt_tokens} out=${usage.completion_tokens}${images ? ` images=${images}` : ''}${calls.length ? ` tools=${calls.map((c) => c.function.name).join(',')}` : ''}`);

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.end(streamEvents({ id, model, content: text, calls }));
  } else {
    send(res, 200, completion({ id, model, content: text, calls, usage }));
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
  try {
    if (req.method === 'GET' && (path === '' || path === '/health')) return send(res, 200, { ok: true, name: 'Capri Claude Code bridge', model: config.model, running, waiting: waiting.length });
    if (!authorized(req)) return sendError(res, 401, 'Wrong or missing bridge token.', 'authentication_error');
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return send(res, 200, modelList(config.model));
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) return await chat(req, res);
    sendError(res, 404, `Nothing here: ${req.method} ${path}`, 'not_found');
  } catch (error) {
    const status = error instanceof ClaudeError ? error.status : 500;
    if (status !== 499) console.error(`${new Date().toISOString()} error ${status}: ${error.message}`);
    sendError(res, status === 499 ? 400 : status, error.message, status === 429 ? 'rate_limit_error' : 'bridge_error');
  }
});

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set CAPRI_BRIDGE_PORT to another port.` : error.message);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`Capri Claude Code bridge on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`Default model: ${config.model}, effort: ${config.effort || 'default'}, ${config.maxConcurrent} at a time${config.token ? ', token required' : ''}.`);
  console.log(`In Capri, connect a brain server at http://localhost:${config.port}`);
});

let closing = false;
function shutdown(why) {
  if (closing) return;
  closing = true;
  console.log(`Stopping (${why}).`);
  stopAll();
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));

// When Capri starts the bridge, she holds its stdin open. If she quits or crashes, the
// pipe closes and the bridge goes with her, so it's never left running on its own.
if (process.env.CAPRI_BRIDGE_WATCH_STDIN) {
  process.stdin.on('end', () => shutdown('Capri closed'));
  process.stdin.on('error', () => shutdown('Capri closed'));
  process.stdin.resume();
}
