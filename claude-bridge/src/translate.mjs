// Translation between the OpenAI chat format Capri speaks and the single stream-json
// user turn that `claude -p` takes. Pure functions only, so they are easy to test.

// The models Capri sees in its model menu, and the Claude Code alias each one runs.
export const MODELS = [
  { id: 'claude-sonnet', alias: 'sonnet' },
  { id: 'claude-opus', alias: 'opus' },
  { id: 'claude-haiku', alias: 'haiku' },
];

// Capri sends "capri" as the model name when none is picked. Anything that is not one of
// ours (like a full id such as claude-sonnet-5-5) goes to Claude Code as it is.
export function aliasFor(model, fallback) {
  if (!model || model === 'capri') return fallback;
  const listed = MODELS.find((m) => m.id === model);
  return listed ? listed.alias : model;
}

export function modelList(defaultAlias) {
  const sorted = [...MODELS].sort((a, b) => (b.alias === defaultAlias) - (a.alias === defaultAlias));
  return {
    object: 'list',
    data: sorted.map((m) => ({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: 'claude-code',
      // Capri reads vision from either of these shapes, depending on the platform.
      capabilities: { vision: true, tools: true },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools'],
    })),
  };
}

const TOOL_OPEN = '<tool_calls>';
const TOOL_CLOSE = '</tool_calls>';

// OpenAI tools as the short list the model reads in its system prompt.
export function toolInstructions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const listed = tools
    .map((t) => t && (t.function || t))
    .filter((f) => f && f.name)
    .map((f) => ({ name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } }));
  if (listed.length === 0) return '';
  return [
    '# Tools',
    'You can call these tools:',
    JSON.stringify(listed),
    '',
    'To call one or more tools, end your reply with exactly one block like this:',
    `${TOOL_OPEN}[{"name": "tool_name", "arguments": {"key": "value"}}]${TOOL_CLOSE}`,
    'Anything before the block is your normal reply. Only call tools listed above, with arguments that match their parameters.',
    'Never mention or explain this block format. When no tool is needed, reply normally with no block.',
  ].join('\n');
}

function imageBlock(url) {
  const data = /^data:([^;,]+);base64,(.*)$/s.exec(url || '');
  if (data) return { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url || '')) return { type: 'image', source: { type: 'url', url } };
  return null;
}

// Ollama-style messages carry bare base64 pictures in an "images" array.
function bareImage(base64) {
  const type = base64.startsWith('iVBOR') ? 'image/png' : base64.startsWith('R0lGOD') ? 'image/gif' : base64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: type, data: base64 } };
}

// A message's content as Claude content blocks: text and pictures, in order.
function contentBlocks(message) {
  const blocks = [];
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length) blocks.push({ type: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
      else if (part.type === 'image_url') {
        const image = imageBlock(typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url);
        if (image) blocks.push(image);
      }
    }
  }
  if (Array.isArray(message.images)) for (const base64 of message.images) if (base64) blocks.push(bareImage(base64));
  return blocks;
}

function textOf(message) {
  return contentBlocks(message).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function callsText(calls) {
  const list = calls
    .map((c) => c && c.function)
    .filter(Boolean)
    .map((f) => {
      let args = f.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep the string */ } }
      return { name: f.name, arguments: args ?? {} };
    });
  return list.length ? `${TOOL_OPEN}${JSON.stringify(list)}${TOOL_CLOSE}` : '';
}

// Turns an OpenAI request into the system prompt and the one user turn for Claude Code.
// Earlier turns become a tagged transcript, so Claude sees the whole chat in one message.
export function buildPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages.filter(Boolean) : [];
  const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map(textOf).filter(Boolean);
  const tools = toolInstructions(body.tools);
  if (tools) system.push(tools);

  const turns = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const last = turns.length && turns[turns.length - 1].role === 'user' ? turns[turns.length - 1] : null;
  const earlier = last ? turns.slice(0, -1) : turns;

  const blocks = [];
  if (earlier.length) {
    blocks.push({ type: 'text', text: 'The conversation so far:\n<history>' });
    for (const m of earlier) {
      if (m.role === 'assistant') {
        const said = [textOf(m), Array.isArray(m.tool_calls) ? callsText(m.tool_calls) : ''].filter(Boolean).join('\n');
        blocks.push({ type: 'text', text: `<assistant>${said}</assistant>` });
      } else if (m.role === 'tool' || m.role === 'function') {
        const name = m.name ? ` name="${m.name}"` : '';
        blocks.push({ type: 'text', text: `<tool_result${name}>${textOf(m)}</tool_result>` });
      } else {
        blocks.push({ type: 'text', text: '<user>' }, ...contentBlocks(m), { type: 'text', text: '</user>' });
      }
    }
    blocks.push({ type: 'text', text: '</history>' });
    blocks.push({ type: 'text', text: last ? 'Now reply to this message:' : 'Continue as the assistant.' });
  }
  if (last) blocks.push(...contentBlocks(last));
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(empty message)' });

  return { system: system.join('\n\n'), content: mergeText(blocks) };
}

// Neighbouring text blocks joined into one, so the turn stays small and readable.
function mergeText(blocks) {
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (b.type === 'text' && prev && prev.type === 'text') prev.text += '\n' + b.text;
    else merged.push(b.type === 'text' ? { ...b } : b);
  }
  return merged;
}

let callCounter = 0;

// Splits Claude's answer into the reply text and the tool calls it asked for.
// Calls to tools Capri did not offer are dropped.
export function parseReply(text, tools) {
  const offered = new Set((Array.isArray(tools) ? tools : []).map((t) => t && (t.function || t)).filter(Boolean).map((f) => f.name));
  const raw = text || '';
  if (offered.size === 0) return { content: raw.trim(), calls: [] };
  const start = raw.lastIndexOf(TOOL_OPEN);
  if (start < 0) return { content: raw.trim(), calls: [] };
  const end = raw.indexOf(TOOL_CLOSE, start);
  const inside = raw.slice(start + TOOL_OPEN.length, end < 0 ? raw.length : end).trim();
  const content = (raw.slice(0, start) + (end < 0 ? '' : raw.slice(end + TOOL_CLOSE.length))).trim();
  let list;
  try { list = JSON.parse(inside); } catch { return { content: raw.trim(), calls: [] }; }
  if (!Array.isArray(list)) list = [list];
  const calls = list
    .filter((c) => c && typeof c.name === 'string' && offered.has(c.name))
    .map((c) => ({
      id: `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
    }));
  return { content, calls };
}

export function completion({ id, model, content, calls, usage }) {
  const message = { role: 'assistant', content: content || (calls.length ? null : '') };
  if (calls.length) message.tool_calls = calls;
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
    usage,
  };
}

// The same answer as server-sent events, for clients that ask for a stream.
export function streamEvents({ id, model, content, calls }) {
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const events = [chunk({ role: 'assistant', content: content || '' }, null)];
  if (calls.length) events.push(chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) }, null));
  events.push(chunk({}, calls.length ? 'tool_calls' : 'stop'));
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}
