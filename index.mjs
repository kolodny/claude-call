#!/usr/bin/env node
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import debug from 'debug';

const { version: VERSION } = createRequire(import.meta.url)('./package.json');
const log = debug('claude-call');
const usage = { input_tokens: 1, output_tokens: 1 };

function startServer(port, timeoutMs, routes = {}) {
  return new Promise((resolvePort) => {
    let server;
    const close = () => server?.close().closeAllConnections?.();
    if (timeoutMs > 0) {
      setTimeout(() => {
        log(`${timeoutMs}ms deadline; exiting`);
        close();
      }, timeoutMs).unref();
    }

    // tool_use ids we've handed out; their corresponding tool_result ends a turn.
    const issued = new Set();

    server = http.createServer(async (req, res) => {
      for (const [path, handler] of Object.entries(routes)) {
        if (req.url.startsWith(path)) return handler(req, res);
      }
      if (req.url.startsWith('/kill')) {
        log('kill requested');
        res.writeHead(200).end();
        return close();
      }
      if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => (body += c));
      await new Promise((r) => req.once('end', r));
      const { messages } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // A 1-msg request marks the start of a new turn (claude session state has
      // been reset for this user input) — drop any ids issued on prior turns.
      if (messages.length === 1) issued.clear();
      // Scan the whole convo for a tool_result that answers a tool_use we issued.
      // Stream-json mode keeps history across turns and prepends old tool_results
      // to new user messages, so we can't use block order — only matching ids
      // reliably tells us "this tool call is done, time to end_turn".
      for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content) {
          if (b.type === 'tool_result' && issued.has(b.tool_use_id)) {
            const c = b.content;
            const text = typeof c === 'string' ? c : JSON.stringify(c);
            log(`tool_result(${b.tool_use_id}) → end_turn (${text.length}B)`);
            return res.end(JSON.stringify({
              content: [{ type: 'text', text }],
              stop_reason: 'end_turn',
              usage,
            }));
          }
        }
      }
      // No answered tool_use yet — find the new user prompt (last text block).
      const raw = messages.at(-1).content;
      const blocks = Array.isArray(raw) ? raw : [{ type: 'text', text: raw }];
      const textBlock = blocks.filter((b) => b.type === 'text').at(-1);
      if (textBlock) {
        try {
          const { tool, input } = JSON.parse(textBlock.text);
          if (typeof tool === 'string') {
            const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
            issued.add(id);
            log(`prompt → tool_use(${tool}) id=${id}`);
            return res.end(JSON.stringify({
              content: [{ type: 'tool_use', id, name: tool, input }],
              stop_reason: 'tool_use',
              usage,
            }));
          }
        } catch {}
      }
      log(`fallthrough`);
      res.end(JSON.stringify({
        content: [{ type: 'text', text: '' }],
        stop_reason: 'end_turn',
        usage,
      }));
    });
    server.listen(port, '127.0.0.1', () => {
      log(`server: http://127.0.0.1:${server.address().port}`);
      resolvePort({ port: server.address().port, close });
    });
  });
}

function deepMerge(a, b) {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) {
    const existing = out[k];
    const isPlainObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if (isPlainObj(v) && isPlainObj(existing)) out[k] = deepMerge(existing, v);
    else out[k] = v;
  }
  return out;
}

function spawnStreamingClaude(port, { onExit, extraSettings } = {}) {
  // mcpServers must go through --mcp-config; claude registers MCPs during init,
  // before --settings is applied, so mcpServers inside --settings is silently ignored.
  const { mcpServers, ...restSettings } = extraSettings ?? {};
  // Three layers, lowest-to-highest precedence:
  //  1. Our defaults (automation-friendly behavior; user can override).
  //  2. User's --settings (deep-merges on top).
  //  3. Our required fake-server pointer (always wins, else we intercept nothing).
  // Placeholder API key ensures claude starts even when the user has no
  // apiKeyHelper / real key configured; value doesn't matter (server ignores).
  const defaults = { disableAllHooks: true };
  const required = {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      ANTHROPIC_API_KEY: 'sk-fake',
    },
  };
  const merged = deepMerge(deepMerge(defaults, restSettings), required);
  const args = [
    '--input-format=stream-json',
    '--output-format=stream-json',
    '--verbose',
    '-p',
    '--permission-mode=bypassPermissions',
    '--no-session-persistence',
    '--settings', JSON.stringify(merged),
  ];
  if (mcpServers) args.push('--mcp-config', JSON.stringify({ mcpServers }));
  const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const queue = [];
  let alive = true;

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    log(`claude → ${msg.type}${msg.subtype ? '.' + msg.subtype : ''}`);
    if (msg.type !== 'result') return;
    const p = queue.shift();
    if (!p) return;
    if (msg.subtype === 'success') p.resolve(msg.result ?? '');
    else p.reject(new Error(msg.result || msg.error || `claude ${msg.subtype}`));
  });
  child.on('exit', (code) => {
    alive = false;
    log(`claude exited ${code}`);
    for (const p of queue) p.reject(new Error(`claude exited with code ${code}`));
    onExit?.(code);
  });

  const send = (tool, input) => new Promise((resolve, reject) => {
    if (!alive) return reject(new Error('claude is not alive'));
    queue.push({ resolve, reject });
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: JSON.stringify({ tool, input }) },
    }) + '\n';
    child.stdin.write(line);
  });

  return { send, kill: () => child.kill() };
}

const exit = (msg, code = 0) => {
  console[code === 0 ? 'log' : 'error'](msg);
  process.exit(code);
};

// Claude's built-in Bash tool truncates output over ~50KB, writing the full
// stdout to a file and returning a <persisted-output> wrapper with a preview.
// Transparently reinline the full file so callers see complete output.
async function expandPersistedOutput(text) {
  if (typeof text !== 'string' || !text.startsWith('<persisted-output>')) return text;
  const m = text.match(/Full output saved to:\s*(\S+)/);
  if (!m) return text;
  try {
    return await readFile(m[1], 'utf8');
  } catch {
    return text;
  }
}

async function runCall(tool, input, timeoutMs, extraSettings) {
  const { port, close } = await startServer(0, timeoutMs);
  const claude = spawnStreamingClaude(port, { extraSettings });
  try {
    return await claude.send(tool, input);
  } finally {
    claude.kill();
    close();
  }
}

async function runViaServer(serverPort, tool, input, timeoutMs) {
  const ctrl = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(`http://127.0.0.1:${serverPort}/call`, {
      method: 'POST',
      body: JSON.stringify({ tool, input }),
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`server ${r.status}: ${text}`);
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`call timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runServe(port, timeoutMs, skipClaude, extraSettings) {
  let claude;
  let ready = !!skipClaude; // skip-claude has nothing to warm up
  const routes = {};
  const { port: actual, close } = await startServer(port, timeoutMs, routes);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    close();
    claude?.kill();
  };
  process.on('SIGINT', () => { shutdown(); process.exit(130); });
  process.on('SIGTERM', () => { shutdown(); process.exit(143); });

  if (!skipClaude) {
    claude = spawnStreamingClaude(actual, {
      extraSettings,
      onExit: (code) => {
        if (shuttingDown) return;
        console.error(`claude-call: claude subprocess exited (code ${code}); shutting down`);
        close();
        process.exit(code ?? 1);
      },
    });
    // Warmup: force MCPs to connect and the stream-json session to initialize so
    // the first real call is warm. `Bash true` is the cheapest built-in.
    claude.send('Bash', { command: 'true' })
      .then(() => { ready = true; log('ready'); })
      .catch((e) => log(`warmup failed: ${e.message}`));
    routes['/call'] = async (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      await new Promise((r) => req.once('end', r));
      try {
        const { tool, input } = JSON.parse(body);
        const result = await claude.send(tool, input);
        res.writeHead(200).end(result);
      } catch (e) {
        res.writeHead(500).end(String(e?.message ?? e));
      }
    };
  }
  routes['/ready'] = (_req, res) => {
    if (ready) res.writeHead(200).end('ready');
    else res.writeHead(503).end('not ready');
  };
  // Override built-in /kill to also stop claude and exit.
  routes['/kill'] = (_req, res) => {
    log('kill requested');
    res.writeHead(200).end();
    setImmediate(shutdown);
  };
  // writeSync bypasses Node's block buffering for redirected stdout (e.g.
  // `serve > cc.out &`) so callers can immediately read the port/pid line.
  writeSync(1, JSON.stringify({ port: actual, pid: process.pid }) + '\n');
}

function parseJsonObject(raw) {
  const v = JSON.parse(raw);
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('--settings must be a JSON object');
  }
  return v;
}

const SETTINGS_DESC = `extra settings JSON to pass to claude (e.g. \'{"disableAllHooks":true}\')`;

const program = new Command()
  .name('claude-call')
  .version(VERSION)
  // Needed so that options declared on both root and subcommands (like --settings)
  // are parsed independently per scope rather than captured at the root.
  .enablePositionalOptions()
  .argument('<tool>')
  .argument('[input]', 'JSON tool args', '{}')
  .option('-t, --timeout <ms>', 'hard deadline (also per-call timeout for --server)', Number, 120_000)
  .option('--server <port>', 'target a running `claude-call serve` on this port', Number)
  .option('--settings <json>', SETTINGS_DESC, parseJsonObject)
  .action((tool, inputJson, { timeout, server, settings }) => {
    const input = JSON.parse(inputJson);
    const p = server
      ? runViaServer(server, tool, input, timeout)
      : runCall(tool, input, timeout, settings);
    p.then(expandPersistedOutput).then(
      (result) => process.stdout.write(result),
      (e) => exit(`${e?.message ?? e}`, 1),
    );
  });

program
  .command('serve')
  .description('run fake API + long-running claude in the foreground; prints <port> <pid>')
  .option('-p, --port <n>', 'listen port', Number, 0)
  .option('-t, --timeout <ms>', 'hard deadline, 0 = never', Number, 0)
  .option('--skip-claude', "don't launch claude; only expose /v1/messages (bring your own claude via ANTHROPIC_BASE_URL)")
  .option('--settings <json>', SETTINGS_DESC, parseJsonObject)
  .action(({ port, timeout, skipClaude, settings }) => runServe(port, timeout, skipClaude, settings));

program.parse();
