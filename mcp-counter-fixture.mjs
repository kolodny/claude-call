#!/usr/bin/env node
// Minimal stateful MCP server for tests. Exposes an in-process counter with
// `increment` and `read` tools. Used to verify that `claude-call serve`
// preserves MCP state across successive --server calls.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'counter', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

let count = 0;
const EMPTY = { type: 'object', properties: {} };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'increment', description: 'increment counter; return new value', inputSchema: EMPTY },
    { name: 'read', description: 'return current counter value', inputSchema: EMPTY },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  if (name === 'increment') count++;
  else if (name !== 'read') throw new Error(`unknown tool: ${name}`);
  return { content: [{ type: 'text', text: String(count) }] };
});

await server.connect(new StdioServerTransport());
