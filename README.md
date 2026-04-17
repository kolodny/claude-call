# claude-call

[![npm version](https://img.shields.io/npm/v/claude-call.svg)](https://www.npmjs.com/package/claude-call)
[![npm downloads](https://img.shields.io/npm/dm/claude-call.svg)](https://www.npmjs.com/package/claude-call)

Invoke Claude tools directly.

## Why

Your project already has Claude Code working — MCP servers authenticated, env vars set, permissions dialed in. `claude-call` reuses all of that to invoke a single tool directly, so you don't have to replicate the MCP auth dance or rebuild the environment just to call one tool from a script. No LLM in the loop: no reasoning, no tokens. Under a second, end-to-end.

## Usage

```bash
npx claude-call mcp__linear__get_issue '{"id":"ENG-123"}'
```

Tool name format is `mcp__<server>__<tool>`. The `input` JSON must match the tool's schema exactly. The tool's result is printed to stdout; exit is `0` on success, `1` if something went wrong (stderr has the message).

<details>
<summary><h2 style="display:inline">Advanced: <code>--serving</code></h2></summary>

Starts a fake Anthropic Messages API, prints the listening port, exits. The server keeps running in a detached child. Use when you want to compose the `claude -p` invocation yourself.

```bash
PORT=$(npx claude-call --serving mcp__linear__get_issue '{"id":"ENG-123"}')

ANTHROPIC_API_KEY=sk-fake claude -p \
  --settings "{\"env\":{\"ANTHROPIC_BASE_URL\":\"http://127.0.0.1:$PORT\"},\"permissions\":{\"allow\":[\"mcp__linear__get_issue\"]}}" \
  --permission-mode acceptEdits \
  --output-format json "go" \
  | jq -r .result
```

Turn 1 of the scripted conversation returns a `tool_use` block for your tool. Turn 2 echoes the `tool_result` as the end_turn text, so claude's `.result` field is exactly the tool's output.

</details>

## License

MIT
