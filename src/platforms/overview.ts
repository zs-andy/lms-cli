import type { PlatformDefinition, ReadCall } from './types.js';
import { LmsError } from '../errors.js';

/** Each contributor owns a bounded plan. Core owns total concurrency, routing and results. */
export function planOverview(definitions: readonly PlatformDefinition[], days: number, now = new Date()) {
  const calls: ReadCall[] = [];
  const scopes: Record<string, unknown> = {};
  const legacyScope: Record<string, unknown> = {};
  const unsupportedPlatforms: string[] = [];
  for (const definition of definitions) {
    const plan = definition.overview?.({ days, now });
    if (!plan) {
      unsupportedPlatforms.push(definition.id);
      scopes[definition.id] = { supported: false, reason: 'No reviewed overview plan is available.' };
      continue;
    }
    if (!plan.calls.length || plan.calls.length > 8 || plan.calls.some(call => !definition.readTools.includes(call.tool))) {
      throw new LmsError('INVALID_PLATFORM_PLAN', 'Overview must contain 1–8 reviewed read calls owned by its platform.');
    }
    calls.push(...plan.calls);
    scopes[definition.id] = plan.scope;
    Object.assign(legacyScope, plan.legacyScope);
  }
  return { calls, unsupportedPlatforms, scope: { ...legacyScope, days, platforms: scopes, attachmentsRead: false } };
}
