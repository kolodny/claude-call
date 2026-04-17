#!/usr/bin/env node
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import debug from 'debug';

const execFileP = promisify(execFile);

const DAEMON_FLAG = 'CLAUDE_SCRIPTED_MCP_DAEMON';
const log = debug('claude-scripted-mcp');

const usage = { input_tokens: 1, output_tokens: 1 };

function startServer(tool, input, port, timeoutMs) {
  return new Promise((resolvePort) => {
    const close = () => server.close().closeAllConnections?.();
    setTimeout(() => {
      log(`${timeoutMs}ms deadline; exiting`);
      close();
    }, timeoutMs).unref();

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end();
      let body = '';
      req.on('data', (c) => (body += c));
      await new Promise((resolve) => req.once('end', resolve));
      const { messages } = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (messages.length === 1) {
        log(`turn 1 → tool_use(${tool})`);
        const content = [{ type: 'tool_use', name: tool, input }];
        return res.end(JSON.stringify({ content, usage }));
      }
      const raw = messages.at(-1).content[0].content;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
      log(`turn 2 → end_turn (${text.length} bytes)`);
      res.end(JSON.stringify({ content: [{ type: 'text', text }], usage }));
    });

    server.listen(port, '127.0.0.1', () => {
      log(`server: http://127.0.0.1:${server.address().port}, tool: ${tool}`);
      resolvePort({ port: server.address().port, close });
    });
  });
}

async function runCall(tool, input, timeoutMs) {
  const { port, close } = await startServer(tool, input, 0, timeoutMs);
  try {
    const env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
    const settings = JSON.stringify({ permissions: { allow: [tool] }, env });
    const args = ['-p', '--settings', settings, '--output-format=json', 'go'];
    const maxBuffer = 16 * 1024 * 1024;
    const { stdout } = await execFileP('claude', args, { maxBuffer });
    return JSON.parse(stdout).result ?? '';
  } finally {
    close();
  }
}

const exit = (msg, code = 0) => {
  console[code === 0 ? 'log' : 'error'](msg);
  process.exit(code);
};

async function runServing(tool, input, port, timeoutMs) {
  if (process.env[DAEMON_FLAG]) {
    // Parent already exited; its stdout pipe is gone.
    process.stdout.on('error', (e) => {
      if (e.code !== 'EPIPE') throw e;
    });
    const { port: actual } = await startServer(tool, input, port, timeoutMs);
    return console.log(actual);
  }
  const stdio = ['ignore', 'pipe', 'inherit'];
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { detached: true, stdio, env: { ...process.env, [DAEMON_FLAG]: '1' } },
  );

  child.once('error', (e) => exit(`${e}`, 1)).unref();
  child.stdout.once('data', (c) => exit(`${c}`.trim()));
  setTimeout(() => exit('daemon never reported port', 1), 5000).unref();
}

const program = new Command()
  .name('claude-scripted-mcp')
  .version('0.1.0')
  .argument('<tool>')
  .argument('[input]', 'JSON tool args', '{}')
  .option('--serving', 'start daemonized fake API, print port, exit')
  .option('-p, --port <n>', 'listen port (--serving only)', Number, 0)
  .option('-t, --timeout <ms>', 'hard deadline', Number, 120_000);
program.parse();

const [tool, inputJson] = program.args;
const { serving, port, timeout } = program.opts();
const input = JSON.parse(inputJson);

if (serving) runServing(tool, input, port, timeout);
else runCall(tool, input, timeout).then(console.log, (e) => exit(`${e}`, 1));
