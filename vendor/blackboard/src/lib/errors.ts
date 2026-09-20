/**
 * Error taxonomy. Tool handlers map these onto user-facing MCP errors, so each
 * one carries a `hint` describing the concrete next action the user can take.
 */

export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_AUTHENTICATED'
  | 'SESSION_EXPIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'NETWORK'
  | 'BAD_INPUT'
  | 'UNSUPPORTED'
  | 'INTERNAL';

export class BlackboardError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly status: number | undefined;
  readonly detail: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { hint?: string; status?: number; detail?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'BlackboardError';
    this.code = code;
    this.hint = opts.hint;
    this.status = opts.status;
    this.detail = opts.detail;
  }

  /** Single-line rendering used in MCP tool error text. */
  describe(): string {
    const parts = [`[${this.code}] ${this.message}`];
    if (this.status !== undefined) parts.push(`(HTTP ${this.status})`);
    if (this.hint) parts.push(`\n\nHint: ${this.hint}`);
    return parts.join(' ');
  }
}

export const notConfigured = (): BlackboardError =>
  new BlackboardError('NOT_CONFIGURED', 'No Blackboard instance configured.', {
    hint: 'Run `blackboard-mcp auth login` (or `blackboard-mcp har import <file.har>`) to set your instance URL and capture a session.',
  });

export const notAuthenticated = (): BlackboardError =>
  new BlackboardError('NOT_AUTHENTICATED', 'No stored Blackboard session.', {
    hint: 'Run `blackboard-mcp auth login` to sign in and store a session.',
  });

export const sessionExpired = (): BlackboardError =>
  new BlackboardError('SESSION_EXPIRED', 'Your Blackboard session is no longer valid.', {
    hint: 'Run `blackboard-mcp auth login` again to refresh it. Blackboard sessions typically expire after a few hours of inactivity.',
  });

/** Normalises anything thrown into a BlackboardError. */
export function toBlackboardError(err: unknown): BlackboardError {
  if (err instanceof BlackboardError) return err;
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT') {
      return new BlackboardError('NETWORK', err.message, {
        hint: 'Check your network connection and that the Blackboard host is reachable.',
        cause: err,
      });
    }
    return new BlackboardError('INTERNAL', err.message, { cause: err });
  }
  return new BlackboardError('INTERNAL', String(err));
}
