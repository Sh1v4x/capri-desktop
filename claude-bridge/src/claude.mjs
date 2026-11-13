// Runs one isolated `claude -p` turn and returns its answer.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class ClaudeError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// An empty folder to run in, so no project CLAUDE.md or settings are picked up.
const QUIET_DIR = join(tmpdir(), 'capri-claude-bridge');
mkdirSync(QUIET_DIR, { recursive: true });

// The child runs on your Claude subscription. An API key in the environment would make
// Claude Code bill that key instead, and the variables of a parent Claude Code session
// would make the child think it is nested, so both are left out.
function childEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'CLAUDECODE' || name === 'CLAUDE_PID' || name === 'CLAUDE_EFFORT' || name.startsWith('CLAUDE_CODE_')) delete env[name];
  }
  if (!process.env.CAPRI_BRIDGE_KEEP_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
  }
  return env;
}

export function claudeArgs({ model, system, effort }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    // No built-in tools, no MCP servers, no hooks, plugins or skills: a plain brain.
    // This also keeps Capri's own Code/Husk hooks from reacting to her brain's turns.
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (effort) args.push('--effort', effort);
  if (system) args.push('--system-prompt', system);
  return args;
}

function failure(text) {
  const said = (text || '').trim() || 'Claude Code failed without saying why.';
  if (/not logged in|\/login|authenticat|oauth|credential/i.test(said)) return new ClaudeError(`Claude Code isn't logged in. Run \`claude\` once in a terminal and log in. (${said})`, 401);
  if (/rate.?limit|usage limit|limit reached|too many requests|overloaded/i.test(said)) return new ClaudeError(`Claude Code hit your plan's limit: ${said}`, 429);
  return new ClaudeError(said, 502);
}

// Every claude turn still running, so the bridge can stop them all when it shuts down.
const live = new Set();

export function stopAll() {
  for (const child of live) child.kill('SIGTERM');
  live.clear();
}

// Resolves with { text, usage } or rejects with a ClaudeError. `signal` aborts the child.
export function runClaude({ bin, model, system, content, effort, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, claudeArgs({ model, system, effort }), { cwd: QUIET_DIR, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new ClaudeError(`Couldn't start Claude Code (${bin}): ${error.message}`, 500));
      return;
    }
    live.add(child);
    child.on('exit', () => live.delete(child));
    let buffer = '', stderr = '', result = null, lastText = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill('SIGTERM');
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new ClaudeError('The request was cancelled.', 499));
    const timer = setTimeout(() => finish(new ClaudeError(`Claude Code took longer than ${Math.round(timeoutMs / 1000)}s.`, 504)), timeoutMs);
    if (signal) { if (signal.aborted) return abort(); signal.addEventListener('abort', abort); }

    const handle = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        const text = event.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (text) lastText = text;
      } else if (event.type === 'result') {
        // The result is the last word. Claude Code can stay alive a while after it
        // (background work), so the answer goes back now and the child is stopped.
        result = event;
        conclude();
      }
    };
    const conclude = (code) => {
      if (result && !result.is_error && result.subtype === 'success') {
        finish(null, { text: typeof result.result === 'string' ? result.result : lastText, usage: result.usage || {} });
      } else if (result) {
        finish(failure(typeof result.result === 'string' && result.result ? result.result : (result.errors || []).join(' ') || stderr || result.subtype));
      } else {
        finish(failure(stderr || `Claude Code exited with code ${code} and no answer.`));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk; });
    child.on('error', (error) => finish(new ClaudeError(error.code === 'ENOENT' ? `Claude Code isn't installed or isn't on PATH (looked for "${bin}"). Set CLAUDE_BIN to its full path.` : error.message, 500)));
    child.on('close', (code) => {
      handle(buffer);
      conclude(code);
    });

    child.stdin.on('error', () => { /* the close handler reports what went wrong */ });
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}
