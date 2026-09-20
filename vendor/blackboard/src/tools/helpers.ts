import { BlackboardClient } from '../client/index.js';
import { toBlackboardError } from '../lib/errors.js';
import { log } from '../lib/logger.js';

/** The shape an MCP tool handler must return. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

export const text = (body: string): ToolResult => ({
  content: [{ type: 'text', text: body }],
});

/**
 * Wraps a tool handler so every failure reaches the model as actionable text
 * rather than a protocol-level error.
 *
 * A thrown MCP error tells the model only that something broke. A returned
 * error with a hint ("run `blackboard-mcp auth login`") lets it either recover
 * or tell the user exactly what to do, which is the difference between a dead
 * end and a working session.
 */
export function guard<A>(
  name: string,
  handler: (args: A) => Promise<ToolResult>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const started = Date.now();
    try {
      const result = await handler(args);
      log.debug(`${name} ok`, { ms: Date.now() - started });
      return result;
    } catch (err) {
      const be = toBlackboardError(err);
      log.warn(`${name} failed: ${be.code}`, be.message);
      return { content: [{ type: 'text', text: be.describe() }], isError: true };
    }
  };
}

/**
 * A single client per process, created lazily.
 *
 * Construction reads the session off disk and decrypts it, so doing it per
 * tool call would mean a keychain round trip every time.
 */
let clientPromise: Promise<BlackboardClient> | null = null;

export function getClient(): Promise<BlackboardClient> {
  clientPromise ??= BlackboardClient.create().catch((err) => {
    clientPromise = null; // Let the next call retry after the user signs in.
    throw err;
  });
  return clientPromise;
}

export function resetClient(): void {
  clientPromise = null;
}

// ── output formatting ─────────────────────────────────────────────────────

/**
 * Renders rows as a compact markdown table.
 *
 * Tables beat JSON here: they cost roughly half the tokens for tabular data
 * and models read them accurately. Columns whose every value is empty are
 * dropped, so a tenant that does not populate a field does not pay for it.
 */
export function table(rows: Array<Record<string, string | number | undefined>>): string {
  // Many tools render a two-column {field, value} list. An absent value should
  // drop the whole row, not leave a blank one, so these read as facts rather
  // than as a form with gaps.
  const isFieldValue =
    rows.length > 0 &&
    rows.every((r) => {
      const keys = Object.keys(r);
      return keys.length === 2 && keys[0] === 'field' && keys[1] === 'value';
    });
  if (isFieldValue) {
    rows = rows.filter((r) => r.value !== undefined && r.value !== '' && r.value !== null);
  }
  if (rows.length === 0) return '_No results._';
  const keys = Object.keys(rows[0]!).filter((k) =>
    rows.some((r) => r[k] !== undefined && r[k] !== ''),
  );
  if (keys.length === 0) return '_No results._';

  const cell = (v: string | number | undefined): string =>
    v === undefined || v === null ? '' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const lines = [
    `| ${keys.join(' | ')} |`,
    `| ${keys.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${keys.map((k) => cell(r[k])).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/** Truncates a string for display, marking that it was cut. */
export function clip(s: string | undefined, max = 300): string {
  if (!s) return '';
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Formats an ISO timestamp (or epoch ms) as a short local date-time. */
export function when(value: string | number | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  const d = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  // Keep the explicit UTC offset; dropping Z made local timetable synthesis ambiguous.
  return d.toISOString();
}

/** Days from now, as a signed human string ("in 3d", "4d overdue", "today"). */
export function relativeDue(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return '1d overdue';
  if (days < 0) return `${-days}d overdue`;
  return `in ${days}d`;
}

/** Section heading plus body, skipped entirely when the body is empty. */
export function section(title: string, body: string): string {
  const trimmed = body.trim();
  return trimmed ? `\n## ${title}\n\n${trimmed}\n` : '';
}

/**
 * Normalises an ISO date/window from loose user input.
 *
 * Models pass "next week", "2026-09-15", or nothing at all; the calendar and
 * to-do endpoints require a concrete `since`/`until` pair.
 */
export function dateWindow(opts: { days?: number; since?: string; until?: string }): {
  since: string;
  until: string;
} {
  const now = new Date();
  const days = opts.days ?? 14;
  const since = opts.since ? new Date(opts.since) : new Date(now.getTime() - 7 * 86_400_000);
  const until = opts.until ? new Date(opts.until) : new Date(now.getTime() + days * 86_400_000);
  return { since: since.toISOString(), until: until.toISOString() };
}
