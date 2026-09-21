/** Public contract for built-in, reviewed platform integrations. No vendor imports here. */
export interface CredentialCandidate {
  kind: 'cookie' | 'token';
  value: string;
  userAgent?: string;
}

/** The payload is opaque to core; the platform validates its own stored format. */
export interface StoredCredential {
  kind: string;
  value: string;
  userAgent?: string;
  validatedAt: string;
}

export interface RuntimeContext {
  profileId: string;
  origin: string;
  stateHome: string;
}

/** Loaded only inside a dedicated platform/profile worker, never the public MCP process. */
export interface PlatformRuntime {
  configure(context: RuntimeContext): void;
  validate(context: RuntimeContext, candidate: CredentialCandidate): Promise<StoredCredential>;
  install(
    context: RuntimeContext,
    credential: StoredCredential | null,
    persist: (credential: StoredCredential) => Promise<void>,
  ): Promise<void>;
  serve(): Promise<void>;
}

export interface ReadCall {
  tool: string;
  args?: Record<string, unknown>;
}

export interface OverviewPlan {
  calls: ReadCall[];
  /** Scope is returned under this platform's ID; never claim exhaustive coverage. */
  scope: Record<string, unknown>;
  /** Existing response fields only; new integrations should use the namespaced scope above. */
  legacyScope?: Record<string, unknown>;
}

export interface PlatformDefinition {
  /** Stable lowercase ID: config key, CLI command, vault slot. Do not rename released IDs. */
  id: string;
  label: string;
  /** All upstream environment namespaces that must be cleared before importing the runtime. */
  environmentPrefixes: readonly string[];
  /** Exact names only. MCP readOnlyHint and name prefixes do not grant permission. */
  readTools: readonly string[];
  aliases: Readonly<Record<string, string>>;
  courseArgument: { name: string; type: 'number' | 'string' };
  login: {
    cookieNames: RegExp;
    sessionCookieNames: readonly string[];
    probePath: string;
  };
  probes: { identity: ReadCall; courses: ReadCall };
  /** Omit when no safe bounded overview is available; core reports the coverage gap. */
  overview?: (options: { days: number; now: Date }) => OverviewPlan;
  limitations: string;
  loadRuntime: () => Promise<PlatformRuntime>;
}
