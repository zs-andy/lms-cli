/**
 * Structured stderr logger.
 *
 * CRITICAL: never write to stdout. Under the stdio transport, stdout is the
 * JSON-RPC channel and any stray byte corrupts the protocol stream.
 */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

function resolveLevel(): LogLevel {
  const raw = (process.env.BLACKBOARD_MCP_LOG_LEVEL ?? '').toLowerCase();
  return raw in LEVELS ? (raw as LogLevel) : 'info';
}

let current: LogLevel = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, meta?: unknown): void {
  if (LEVELS[current] < LEVELS[level]) return;
  const ts = new Date().toISOString();
  let line = `${ts} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (meta !== undefined) {
    try {
      line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
    } catch {
      line += ' [unserialisable meta]';
    }
  }
  process.stderr.write(`${line}\n`);
}

export const log = {
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
};

/** Redacts cookie/token-ish values before they reach a log line. */
export function redact(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}
