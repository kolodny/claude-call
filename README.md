# claude-call

[![npm version](https://img.shields.io/npm/v/claude-call.svg)](https://www.npmjs.com/package/claude-call)
[![npm downloads](https://img.shields.io/npm/dm/claude-call.svg)](https://www.npmjs.com/package/claude-call)

Invoke Claude tools directly.

## Why

Your project already has Claude Code working — MCP servers authenticated, env vars set, permissions dialed in. `claude-call` reuses all of that to invoke a single tool directly, so you don't have to replicate the MCP auth dance or rebuild the environment just to call one tool from a script. No LLM in the loop: no reasoning, no tokens.

## Usage

```bash
npx claude-call mcp__linear__get_issue '{"id":"ENG-123"}'
```

Tool name format is `mcp__<server>__<tool>`. The `input` JSON must match the tool's schema exactly. The tool's result is printed to stdout; exit is `0` on success, `1` if something went wrong (stderr has the message).

Hooks in your Claude Code config are disabled by default — `claude-call` is for scripted dispatch, and interactive hooks can silently deny or hang calls. Re-enable them for a specific invocation with:

```bash
npx claude-call --settings='{"disableAllHooks":false}' Bash '{"command":"ls"}'
```

`--settings <json>` is deep-merged on top of the defaults; anything you can put in Claude Code's `settings.json` goes there.

## Discovering tools

```bash
npx claude-call listToolSchemas
```

Spawns claude briefly, captures its `tools` array (built-ins + every registered MCP), and prints the schemas as JSON. Handy for seeing what tool names exist, what inputs they expect, or feeding into another system that needs the schema. Accepts `--settings` to scope the lookup to specific MCPs.

<details>
<summary><h2 style="display:inline">Advanced: <code>serve</code> + <code>--server</code> for many calls</h2></summary>

Each one-shot call spawns a fresh `claude` subprocess, which pays the full MCP connect cost (~5–20s) *and* starts with fresh MCP state. Two reasons to run a server instead:

1. **Speed** — scripts making many calls skip the reconnect on every call after the first.
2. **Stateful MCPs** — MCPs that hold in-process state reset between one-shot calls, since each call spawns fresh MCP subprocesses. Under `serve`, the MCP subprocesses live as long as the claude child does, so state persists across `--server` calls. If your script depends on state surviving between calls, you **need** `serve` — one-shot won't work.

Run `claude-call serve` to boot one `claude` and keep it alive, then hit it with `--server=<port>`.

`claude-call serve` runs in the foreground. It prints a single JSON line to stdout: `{"port":<num>,"pid":<num>}`. All other output (logs, claude's stderr) goes to stderr so the stdout line is trivially parseable.

Put it in the background with `&` (capturing the first line via a log file), use process substitution, or just run it in a second terminal.

```bash
# Start serve in the background and capture port/pid.
npx claude-call serve > /tmp/cc.out &
until [ -s /tmp/cc.out ]; do sleep 0.1; done
eval "$(jq -r '"PORT=\(.port); PID=\(.pid)"' /tmp/cc.out)"

# Wait until MCPs are connected so the first real call is warm too.
until curl -sf http://127.0.0.1:$PORT/ready > /dev/null; do sleep 0.2; done

# All calls are now fast.
for id in ENG-123 ENG-124 ENG-125; do
  npx claude-call --server=$PORT mcp__linear__get_issue "{\"id\":\"$id\"}"
done

# Stop serve when you're done (SIGINT/SIGTERM also work cleanly).
curl -s http://127.0.0.1:$PORT/kill   # or: kill $PID
```

**Endpoints:** `POST /call` (body: `{tool, input}`) drives claude; `GET /ready` returns 200 once MCPs are connected (claude is warmed with a no-op `Bash true` on startup); `GET /kill` exits.

**Concurrency is 1** — calls against the same server serialize (claude handles one turn at a time). If you need parallelism, start multiple servers.

**Timeouts**: pass `-t/--timeout <ms>` to `claude-call --server=...` to cap a single call; default 120s.

**Per-server `--settings`**: `claude-call serve --settings=<json>` applies to the long-running claude, so every `--server` call inherits it. Useful for registering ad-hoc MCP servers for a script without touching the user's config:

```bash
claude-call serve --settings='{"mcpServers":{"my-thing":{"command":"/abs/path/to/node","args":["my-mcp.mjs"]}}}'
```

> Use an absolute binary path for `mcpServers.*.command`. Shell aliases and functions aren't resolved by the child claude's process spawner — it execs the binary directly.

The server listens on `127.0.0.1` only. It runs claude with `--permission-mode=bypassPermissions`, which is fine for a locally-owned process but would be a bad idea on a shared host.

### `--skip-claude`: bring your own claude

If you want to compose the `claude` invocation yourself, pass `--skip-claude`. `serve` then exposes only the fake `/v1/messages` endpoint (and `/kill`), and you drive claude manually:

```bash
npx claude-call serve --skip-claude > /tmp/cc.out &
until [ -s /tmp/cc.out ]; do sleep 0.1; done
eval "$(jq -r '"PORT=\(.port); PID=\(.pid)"' /tmp/cc.out)"

claude -p \
  --settings "{\"env\":{\"ANTHROPIC_API_KEY\":\"sk-fake\",\"ANTHROPIC_BASE_URL\":\"http://127.0.0.1:$PORT\"}}" \
  --permission-mode bypassPermissions \
  --output-format json \
  '{"tool":"mcp__linear__get_issue","input":{"id":"ENG-123"}}' \
  | jq -r .result

curl -s http://127.0.0.1:$PORT/kill
```

In `--skip-claude` mode there's no `/call` endpoint, so `--server` won't work — you're on your own for talking to claude.

</details>

## License

MIT
