import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');
const run = (args, timeout = 60_000) =>
  execFileP(process.execPath, [cli, ...args], { timeout });

test('one-shot: runs a Bash tool and returns its stdout', async () => {
  const { stdout } = await run(['Bash', '{"command":"echo hello"}'], 30_000);
  assert.equal(stdout.trim(), 'hello');
});

describe('serve daemon', () => {
  let child, port, pid;

  before(async () => {
    child = spawn(process.execPath, [cli, 'serve'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('serve startup timeout')), 30_000);
      child.stdout.once('data', (d) => {
        clearTimeout(to);
        resolve(String(d).trim());
      });
      child.once('exit', (code) => {
        clearTimeout(to);
        reject(new Error(`serve exited early, code=${code}`));
      });
    });
    ({ port, pid } = JSON.parse(line));
  });

  after(async () => {
    try { await fetch(`http://127.0.0.1:${port}/kill`); } catch {}
    if (child && child.exitCode === null) try { child.kill(); } catch {}
  });

  test('serve prints JSON {port, pid}', () => {
    assert.equal(typeof port, 'number');
    assert.equal(typeof pid, 'number');
    assert.ok(port > 0);
    assert.ok(pid > 0);
  });

  test('GET /ready eventually returns 200 after warmup', async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${port}/ready`);
      if (r.status === 200) return;
      await new Promise((x) => setTimeout(x, 100));
    }
    assert.fail('never became ready');
  });

  test('--server handles multiple distinct calls without conversation bleed', async () => {
    const call = async (cmd) => {
      const { stdout } = await run([
        '--server', port, 'Bash', JSON.stringify({ command: cmd }),
      ]);
      return stdout.trim();
    };
    assert.equal(await call('echo alpha'), 'alpha');
    assert.equal(await call('echo beta'), 'beta');
    assert.equal(await call('echo gamma'), 'gamma');
  });

  test('--server stays correct across 20 sequential calls', async () => {
    for (let i = 0; i < 20; i++) {
      const expected = `n${i}`;
      const { stdout } = await run([
        '--server', port, 'Bash', JSON.stringify({ command: `echo ${expected}` }),
      ]);
      assert.equal(stdout.trim(), expected, `call ${i}`);
    }
  });

  test('--server expands claude\'s <persisted-output> for large results', async () => {
    // Claude's Bash tool truncates output ≳50KB into a file + preview wrapper;
    // we reinline it so the caller sees full content regardless of size.
    const n = 200_000;
    const { stdout } = await run([
      '--server', port, 'Bash',
      JSON.stringify({ command: `yes x | head -n ${n} | tr -d '\\n'` }),
    ]);
    const trimmed = stdout.replace(/\n$/, '');
    assert.equal(trimmed.length, n);
    assert.ok(!trimmed.includes('<persisted-output>'), 'wrapper leaked into output');
    assert.match(trimmed, /^x+$/);
  });

  test('GET /kill returns 200 and stops the daemon', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/kill`);
    assert.equal(r.status, 200);
  });
});
