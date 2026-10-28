'use strict';
// Claude Code on the user's subscription, kept warm and locked down.
//
// Every guide step used to spawn a fresh `claude -p`: about 3.5 s of startup
// (the CLI loads the user's settings, CLAUDE.md, MCP servers and hooks, then
// flushes its own telemetry before it exits), all of it in the person's wait.
// This pool starts the next process ahead of the question, with the system
// prompt already on its command line, so a step pays only the model. The
// question goes in as one stream-json message on stdin, screenshot included
// as an image block, so no capture file has to sit where the CLI can read it.
//
// Lock-down, per process: no tools, no MCP servers, no hooks, CLAUDE.md or
// plugins (--safe-mode), nothing saved to disk, an empty app-owned cwd. The
// model can only ever send words back; nothing in a syllabus or on a screen
// can steer a tool. ANTHROPIC_API_KEY is stripped so the subscription pays.
//
// Pure Node: spawn is injected for tests.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn: nodeSpawn, execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const DEFAULT_MAX_SPARES = 2;
const DEFAULT_IDLE_TTL_MS = 120000;
const DEFAULT_FIRST_OUTPUT_MS = 45000;
const DEFAULT_TIMEOUT_MS = 120000;
const LOCKED_ARGS = ['--tools', '', '--strict-mcp-config', '--safe-mode', '--no-session-persistence', '--exclude-dynamic-system-prompt-sections'];

function classifyError(detail) {
  const d = String(detail || '');
  if (/not logged in|\/login|please run .?login/i.test(d)) return 'cli_not_logged_in';
  if (/spend limit|usage limit|rate limit|quota/i.test(d)) return 'cli_spend_limit';
  return 'cli_failed';
}

function killTree(child) {
  if (!child || !child.pid) return;
  try { child.kill(); } catch (_) { /* already gone */ }
  if (IS_WIN) { try { execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {}); } catch (_) { /* best effort */ } }
  else { try { child.kill('SIGKILL'); } catch (_) { /* best effort */ } }
}

// One stream-json run: feed lines, collect deltas, remember the result.
function createParser(onDelta) {
  const p = { produced: false, retried: false, final: '', error: null, detail: '', ended: false, usage: null, costUsd: null, model: '' };
  p.feed = (line) => {
    const s = String(line).trim();
    if (!s.startsWith('{')) return;
    let ev;
    try { ev = JSON.parse(s); } catch (_) { return; }
    const kind = ev.type;
    if (kind === 'stream_event') {
      const inner = ev.event || {}, delta = inner.delta || {};
      if (inner.type === 'message_start' && p.produced) { p.retried = true; return; }   // the CLI retried mid-reply: keep the first attempt
      if (inner.type === 'content_block_delta' && delta.type === 'text_delta' && delta.text && !p.retried) {
        p.produced = true; p.final += delta.text;
        if (onDelta) onDelta(delta.text);
      }
      return;
    }
    if (kind === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      if (ev.message.content.some((b) => b && b.type === 'tool_use')) { p.error = 'cli_ran_tools'; p.ended = true; p.final = ''; return; }
      if (!p.produced) {
        // No partial messages on this CLI build: whole text blocks are the stream.
        const text = ev.message.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
        if (text) { p.produced = true; p.final = text; if (onDelta) onDelta(text); }
      }
      return;
    }
    if (kind === 'result') {
      p.ended = true;
      if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) { p.detail = String(ev.result || ev.subtype || 'error').slice(0, 300); p.error = p.error || classifyError(p.detail); }
      else if (!p.final) p.final = String(ev.result || '');
      p.usage = ev.usage || null;
      p.costUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null;
      const models = ev.modelUsage && typeof ev.modelUsage === 'object' ? Object.keys(ev.modelUsage) : [];
      p.model = models[0] ? String(models[0]).split('[')[0] : '';
    }
  };
  return p;
}

// content: [{type:'text',text}|{type:'image',source:{type:'base64',media_type,data}}]
function userMessage(content) {
  const blocks = (Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }]).map((b) => {
    if (b && b.type === 'image' && b.dataUrl) {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(b.dataUrl);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } } : null;
    }
    return b;
  }).filter(Boolean);
  return JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n';
}

function createClaudePool({ cliPath, cwd, env, log = () => {}, spawn = nodeSpawn, maxSpares = DEFAULT_MAX_SPARES, idleTtlMs = DEFAULT_IDLE_TTL_MS, promptDir, now = () => Date.now(), prewarm = true } = {}) {
  const spares = new Map();        // key -> { child, born, timer }
  const starting = new Set();
  const promptFiles = new Map();   // system text -> file path
  let closed = false;

  function baseEnv() {
    const e = Object.assign({}, env || process.env);
    delete e.ANTHROPIC_API_KEY;
    e.DISABLE_AUTOUPDATER = '1';
    e.CLAUDE_CODE_PROMPT_CACHE_TTL = '5m';          // five-minute writes are ~30% cheaper than hour-long ones
    e.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';  // ~0.45 s after each answer and ~0.25 s at start
    return e;
  }

  // The system prompt rides in a file (argv length and quoting are not an
  // issue on any shell), named by its hash so a repeated prompt is one file.
  function promptFile(system) {
    const text = String(system || '');
    if (promptFiles.has(text)) return promptFiles.get(text);
    const dir = promptDir || path.join(os.tmpdir(), 'nus-claude-prompts');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'system-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 16) + '.txt');
    try { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text); } catch (e) { log('prompt file failed: ' + e.message); }
    promptFiles.set(text, file);
    return file;
  }

  function argv({ model, effort, system }) {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...LOCKED_ARGS];
    if (system) args.push('--system-prompt-file', promptFile(system));
    if (effort) args.push('--effort', String(effort));
    if (model) args.push('--model', String(model));
    return args;
  }

  function launch(args) {
    const isShim = /\.(cmd|bat)$/i.test(cliPath);
    const opts = { cwd: cwd || os.tmpdir(), env: baseEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
    const child = isShim ? spawn('cmd.exe', ['/c', cliPath, ...args], opts) : spawn(cliPath, args, opts);
    child.stdin.on('error', () => {});
    return child;
  }

  function keyOf(args) { return args.join('\u0000'); }

  function discard(entry) {
    if (!entry) return;
    clearTimeout(entry.timer);
    killTree(entry.child);
  }

  // Start a spare for this prompt/model/effort ahead of the question.
  function warm(params) {
    if (closed || !prewarm || !cliPath) return false;
    const args = argv(params), key = keyOf(args);
    const held = spares.get(key);
    if (starting.has(key) || (held && held.child.exitCode == null)) return false;
    starting.add(key);
    let child;
    try { child = launch(args); } catch (e) { starting.delete(key); log('spare failed to start: ' + e.message); return false; }
    starting.delete(key);
    child.on('exit', () => { const cur = spares.get(key); if (cur && cur.child === child) { spares.delete(key); clearTimeout(cur.timer); } });
    child.on('error', () => {});
    while (spares.size >= maxSpares) { const first = spares.keys().next().value; discard(spares.get(first)); spares.delete(first); }
    const born = now();
    const entry = { child, born, timer: setTimeout(() => { const cur = spares.get(key); if (cur && cur.born === born) { spares.delete(key); discard(cur); log('spare reaped'); } }, idleTtlMs) };
    if (entry.timer.unref) entry.timer.unref();
    spares.set(key, entry);
    log('spare started');
    return true;
  }

  function take(args) {
    const key = keyOf(args);
    const held = spares.get(key);
    if (held) {
      spares.delete(key);
      clearTimeout(held.timer);
      if (held.child.exitCode == null && now() - held.born < idleTtlMs) return { child: held.child, warm: true };
      discard(held);
    }
    return { child: launch(args), warm: false };
  }

  // -> { text, usage, costUsd, model, warm, ms } or { error, detail }.
  function run({ model, effort, system, content, onDelta, timeoutMs = DEFAULT_TIMEOUT_MS, firstOutputMs = DEFAULT_FIRST_OUTPUT_MS } = {}) {
    if (!cliPath) return Promise.resolve({ error: 'cli_missing' });
    const args = argv({ model, effort, system });
    return new Promise((resolve) => {
      const t0 = now();
      let child, warmed = false;
      try { ({ child, warm: warmed } = take(args)); } catch (e) { resolve({ error: 'cli_spawn_failed', detail: String(e.message || '').slice(0, 300) }); return; }
      const parser = createParser(onDelta);
      let settled = false, stderr = '', lineBuf = '', firstTimer = null, totalTimer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstTimer); clearTimeout(totalTimer);
        if (parser.ended) { setTimeout(() => { if (child.exitCode == null) killTree(child); }, 300); }
        resolve(Object.assign({ warm: warmed, ms: now() - t0 }, result));
        if (prewarm && !closed) warm({ model, effort, system });   // the next step's process, started now
      };
      firstTimer = setTimeout(() => { if (!parser.produced) { killTree(child); finish({ error: 'cli_timeout', detail: 'no answer started within ' + Math.round(firstOutputMs / 1000) + ' s' }); } }, firstOutputMs);
      totalTimer = setTimeout(() => { killTree(child); finish({ error: 'cli_timeout' }); }, timeoutMs);
      const handle = (line) => {
        parser.feed(line);
        if (parser.produced) clearTimeout(firstTimer);
        if (parser.ended) finish(parser.error ? { error: parser.error, detail: parser.detail || parser.final.slice(0, 300) } : { text: parser.final, usage: parser.usage, costUsd: parser.costUsd, model: parser.model });
      };
      child.stdout.on('data', (chunk) => {
        lineBuf += chunk;
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop();
        for (const line of lines) if (line.trim()) handle(line);
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (e) => finish({ error: 'cli_spawn_failed', detail: String(e.message || '').slice(0, 300) }));
      child.on('close', (code) => {
        if (lineBuf.trim()) handle(lineBuf.trim());
        if (settled) return;
        if (code !== 0 && /unknown option|unrecognized|safe-mode|system-prompt-file|exclude-dynamic/i.test(stderr)) return finish({ error: 'cli_unsupported', detail: String(stderr).slice(0, 300) });
        if (code !== 0) return finish({ error: classifyError(stderr), detail: String(stderr).slice(0, 300) });
        finish(parser.final ? { text: parser.final, usage: parser.usage, costUsd: parser.costUsd, model: parser.model } : { error: 'cli_failed', detail: 'no answer' });
      });
      try { child.stdin.write(userMessage(content)); child.stdin.end(); } catch (e) { finish({ error: 'cli_spawn_failed', detail: String(e.message || '').slice(0, 300) }); }
    });
  }

  function close() {
    closed = true;
    for (const entry of spares.values()) discard(entry);
    spares.clear();
  }

  function status() { return { spares: spares.size, closed }; }

  return { warm, run, close, status, argv, userMessage, LOCKED_ARGS };
}

module.exports = { createClaudePool, createParser, userMessage, classifyError, LOCKED_ARGS };
