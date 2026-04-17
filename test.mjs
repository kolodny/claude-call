import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), 'index.mjs');

test('runs a Bash tool and returns its stdout', async () => {
  const { stdout } = await execFileP(
    process.execPath,
    [cli, 'Bash', '{"command":"echo hello"}'],
    { timeout: 30_000 },
  );
  assert.equal(stdout.trim(), 'hello');
});
