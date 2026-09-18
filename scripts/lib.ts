// Codegen support library for scripts/generate.ts.
//
// JSON Schema → TypeScript conversion is delegated to the canonical
// json-schema-to-typescript package (bcherny) rather than a hand-rolled
// walker, so the full spec ($ref, allOf/oneOf, patternProperties, ...) is
// handled by battle-tested code. sanitizeMethodName() maps MCP tool names
// (typically snake_case) to camelCase method identifiers.

import { compile, type JSONSchema } from 'json-schema-to-typescript';
import type { ToolDefinition } from './emitter.js';

const COMPILE_OPTIONS = {
  bannerComment: '',
  additionalProperties: false,
};

/**
 * Compiles a tool's `inputSchema` into a named TypeScript interface
 * declaration (Prettier-formatted, no banner), e.g.
 * `export interface WebSearchArgs { query: string; }`.
 */
export function compileArgsInterface(schema: unknown, interfaceName: string): Promise<string> {
  return compile((stripTitles(schema) ?? {}) as JSONSchema, interfaceName, COMPILE_OPTIONS);
}

// json-schema-to-typescript turns a nested schema's `title` into a named type
// *reference* without ever emitting its definition, leaving dangling names.
// Titles are meaningless for our anonymous arg interfaces, so drop them all.
function stripTitles(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripTitles);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key !== 'title') out[key] = stripTitles(value);
    }
    return out;
  }
  return schema;
}

/** Maps an MCP tool name (typically snake_case) to a valid camelCase method identifier. */
export function sanitizeMethodName(name: string): string {
  const words = name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .flatMap(splitCamelWords)
    .map((word) => (isAcronym(word) ? word.toLowerCase() : word));

  if (words.length === 0) return '_';

  let out = words[0].toLowerCase();
  for (const word of words.slice(1)) out += word[0].toUpperCase() + word.slice(1);

  if (/^[0-9]/.test(out)) out = '_' + out;
  return out;
}

/** Maps a sanitized method name to its PascalCase args interface name. */
export function argsInterfaceName(methodName: string): string {
  const pascal = methodName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  if (!pascal) return '_Args';
  // Preserve a digit-guard underscore from sanitizeMethodName().
  const guard = methodName.startsWith('_') && !pascal.startsWith('_') ? '_' : '';
  return guard + pascal + 'Args';
}

function splitCamelWords(segment: string): string[] {
  return segment.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [];
}

function isAcronym(word: string): boolean {
  return word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word);
}

/**
 * Canonical JSON object key order for MCP tool definitions. Arrays keep
 * their order (JSON array order is meaningful); object keys are rewritten
 * in this order first, with any unknown keys following alphabetically.
 */
const TOOL_KEY_ORDER = ['name', 'description', 'inputSchema', 'outputSchema'] as const;
const SCHEMA_KEY_ORDER = ['type', 'description', 'enum', 'anyOf', 'oneOf', 'allOf', 'items', 'properties', 'required', 'additionalProperties'] as const;

/**
 * Recursively rebuilds a JSON value with object keys in a stable order:
 * keys listed in `keyOrder` first (in that order), then any unrecognized
 * keys alphabetically. Property order inside a schema object is normalized
 * alphabetically — it carries no meaning in JSON Schema.
 *
 * Upstream MCP servers may return object keys in a different order per
 * request; without this normalization those permutations would show up
 * as snapshot churn even though the tool definitions are unchanged.
 */
export function canonicalKeyOrder(value: unknown, keyOrder: readonly string[] = SCHEMA_KEY_ORDER): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalKeyOrder(item, keyOrder));
  if (value && typeof value === 'object') {
    const entries = new Map(Object.entries(value as Record<string, unknown>));
    const out: Record<string, unknown> = {};
    const emit = (key: string) => {
      if (!entries.has(key)) return;
      out[key] = canonicalKeyOrder(entries.get(key), SCHEMA_KEY_ORDER);
      entries.delete(key);
    };
    for (const key of keyOrder) emit(key);
    for (const key of [...entries.keys()].sort()) emit(key);
    return out;
  }
  return value;
}

/**
 * Canonical tool ordering: sorted by `name` (the emitter already assumes
 * order-independence; this pins the snapshot itself to that order).
 */
export function canonicalToolOrder(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fully canonical form of a tool inventory for snapshotting: sorted by
 * tool name, with nested object keys in a stable order.
 */
export function canonicalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return canonicalToolOrder(tools.map((tool) => canonicalKeyOrder(tool, TOOL_KEY_ORDER) as ToolDefinition));
}
