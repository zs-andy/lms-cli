export class LmsError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message); }
}

/** Never serialize arbitrary exceptions: upstream errors can contain HTTP bodies or secrets. */
export function publicError(error: unknown) {
  if (error instanceof LmsError) return { code: error.code, message: error.message, hint: error.hint };
  return { code: 'INTERNAL', message: 'Operation failed safely; no credentials were logged.', hint: 'Run lms doctor. Check the profile, network, and sign-in status.' };
}
