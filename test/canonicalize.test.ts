// Unit tests for the snapshot canonicalization helpers in scripts/lib.ts.
// The nightly sync commits openapi/mcp-tools.json whenever the regenerated
// snapshot differs; these tests pin the canonicalization that keeps
// response-order churn (tool order, object key order) out of that diff.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeTools,
  canonicalKeyOrder,
  canonicalToolOrder,
  type ToolDefinition,
} from '@scripts/lib.js';

describe('canonicalKeyOrder', () => {
  it('orders object keys by the provided key order, then unknown keys alphabetically', () => {
    assert.deepEqual(
      Object.keys(canonicalKeyOrder(
        { additionalProperties: false, description: 'd', name: 'n', type: 'object', zeta: 1 } as Record<string, unknown>,
        ['name', 'description', 'type'],
      )),
      ['name', 'description', 'type', 'additionalProperties', 'zeta'],
    );
  });

  it('recurses through nested objects and arrays, arrays keep their order', () => {
    const out = canonicalKeyOrder(
      { b: [{ zz: 1, aa: 2 }], a: { y: 1, x: 2 } },
      ['b', 'a'],
    ) as { a: { x: number; y: number }; b: { aa: number; zz: number }[] };
    assert.deepEqual(Object.keys(out), ['b', 'a']);
    assert.deepEqual(Object.keys(out.a), ['x', 'y']);
    assert.deepEqual(out.b, [{ aa: 2, zz: 1 }]);
    assert.deepEqual(Object.keys(out.b[0]), ['aa', 'zz']);
  });

  it('leaves primitives, null, and missing keys untouched', () => {
    assert.equal(canonicalKeyOrder(null), null);
    assert.equal(canonicalKeyOrder(42), 42);
    assert.equal(canonicalKeyOrder('str'), 'str');
    assert.equal(canonicalKeyOrder(true), true);
    assert.deepEqual(Object.keys(canonicalKeyOrder({})), []);
  });
});

describe('canonicalToolOrder', () => {
  it('sorts tools by name regardless of input order', () => {
    const tools: ToolDefinition[] = [
      { name: 'zeta_tool', inputSchema: {} },
      { name: 'alpha_tool', inputSchema: {} },
      { name: 'Mid_tool', inputSchema: {} },
    ];
    assert.deepEqual(
      canonicalToolOrder(tools).map((t) => t.name),
      ['alpha_tool', 'Mid_tool', 'zeta_tool'],
    );
  });

  it('does not mutate the input array', () => {
    const tools: ToolDefinition[] = [
      { name: 'b_tool', inputSchema: {} },
      { name: 'a_tool', inputSchema: {} },
    ];
    canonicalToolOrder(tools);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['b_tool', 'a_tool'],
    );
  });
});

describe('canonicalizeTools', () => {
  const makeTool = (overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition => ({
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  });

  it('sorts by name and reorders tool-level keys before schema keys', () => {
    const [first] = canonicalizeTools([
      makeTool({ name: 'b_tool' }),
      makeTool({ name: 'a_tool' }),
    ]);
    assert.equal(first.name, 'a_tool');
    assert.deepEqual(Object.keys(first), ['name', 'inputSchema']);
  });

  it('normalizes nested inputSchema key order (type before properties, etc.)', () => {
    const [tool] = canonicalizeTools([
      makeTool({
        name: 't',
        inputSchema: {
          required: ['q'],
          additionalProperties: false,
          properties: { q: { description: 'the query', type: 'string' } },
          type: 'object',
        },
      }),
    ]);
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.deepEqual(Object.keys(schema), ['type', 'properties', 'required', 'additionalProperties']);
    assert.deepEqual(Object.keys((schema.properties as Record<string, unknown>).q), ['type', 'description']);
  });

  it('normalizes outputSchema identically', () => {
    const [tool] = canonicalizeTools([
      makeTool({
        name: 't',
        outputSchema: { properties: { s: { type: 'integer' } }, type: 'object' },
      }),
    ]);
    assert.deepEqual(Object.keys(tool.outputSchema as Record<string, unknown>), ['type', 'properties']);
  });

  it('is idempotent and invariant to input permutation', () => {
    const a = makeTool({ name: 'a_tool', inputSchema: { properties: { x: { type: 'string' } }, type: 'object' } });
    const b = makeTool({ name: 'b_tool' });
    const once = canonicalizeTools([a, b]);
    assert.deepEqual(canonicalizeTools(once), once);
    assert.deepEqual(canonicalizeTools([b, a]), once);
  });

  it('preserves array order inside required/enum (arrays are order-significant)', () => {
    const [tool] = canonicalizeTools([
      makeTool({
        name: 't',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['zeta', 'alpha', 'mid'] },
          },
          required: ['mode', 'q'],
        },
      }),
    ]);
    const schema = tool.inputSchema as Record<string, unknown>;
    assert.deepEqual(schema.required, ['mode', 'q']);
    assert.deepEqual((schema.properties as Record<string, unknown>).mode, {
      type: 'string',
      enum: ['zeta', 'alpha', 'mid'],
    });
  });

  it('round-trips through JSON.stringify/parse unchanged', () => {
    const tools = canonicalizeTools([
      makeTool({ name: 'b_tool' }),
      makeTool({ name: 'a_tool', inputSchema: { properties: { q: { type: 'string' } }, required: ['q'], type: 'object' } }),
    ]);
    const text = JSON.stringify({ tools }, null, 2) + '\n';
    assert.deepEqual(canonicalizeTools(JSON.parse(text).tools), tools);
  });
});
