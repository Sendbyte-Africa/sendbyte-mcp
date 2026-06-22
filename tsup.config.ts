import { defineConfig } from 'tsup';

// The MCP server ships as a single executable ESM bundle invoked over stdio
// (`npx sendbyte-mcp`). The shebang is added here rather than in source so the
// source stays importable by the test suite without a stray interpreter line.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
