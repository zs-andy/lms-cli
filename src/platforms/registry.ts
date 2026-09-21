import { canvas } from './canvas/index.js';
import { blackboard } from './blackboard/index.js';
import type { PlatformDefinition } from './types.js';
import { LmsError } from '../errors.js';

// The single registration point. Import metadata only; runtimes are lazy worker imports.
export const platformDefinitions = [canvas, blackboard] as const;
export type PlatformId = typeof platformDefinitions[number]['id'];
export const platformIds = platformDefinitions.map(p => p.id) as [PlatformId, ...PlatformId[]];

/** Fail closed on mistakes in a contribution instead of silently routing to the wrong MCP. */
export function createRegistry(definitions: readonly PlatformDefinition[]) {
  const byId = new Map<string, PlatformDefinition>();
  const byTool = new Map<string, PlatformDefinition>();
  const reserved = new Set(['all', 'id', 'label', 'timezone', 'preset', 'profile', 'json', 'help', 'version', 'init', 'presets', 'profiles', 'auth', 'tools', 'call', 'overview', 'check', 'ask', 'mcp', 'mcp-config', 'items', 'doctor', 'setup', 'connect', 'update', 'schools', 'school', 'platform', 'offline', 'manual', 'constructor', 'prototype', '__proto__']);
  for (const definition of definitions) {
    const fail = (reason: string): never => { throw new Error(`Invalid platform ${definition.id}: ${reason}`); };
    if (!/^[a-z][a-z0-9]*$/.test(definition.id) || reserved.has(definition.id) || byId.has(definition.id)) fail('invalid, reserved or duplicate ID');
    if (!definition.label.trim() || !definition.limitations.trim()) fail('label and limitations are required');
    if (!definition.environmentPrefixes.length || definition.environmentPrefixes.some(prefix => !/^[A-Z][A-Z0-9_]*_$/.test(prefix) || /^(LMS_|NODE_|ELECTRON_)/.test(prefix))) fail('declare only upstream environment namespaces');
    if (definition.login.cookieNames.global || definition.login.cookieNames.sticky || !definition.login.sessionCookieNames.length || definition.login.sessionCookieNames.some(name => !definition.login.cookieNames.test(name))) fail('invalid cookie policy');
    if (!definition.login.probePath.startsWith('/') || definition.login.probePath.startsWith('//')) fail('probePath must be a relative API path');
    if (!definition.readTools.length) fail('at least one reviewed read tool is required');
    for (const name of definition.readTools) {
      if (!/^[a-z][a-z0-9_]*$/.test(name) || byTool.has(name)) fail(`invalid or duplicate tool ${name}`);
      byTool.set(name, definition);
    }
    for (const name of [...Object.values(definition.aliases), definition.probes.identity.tool, definition.probes.courses.tool]) {
      if (!definition.readTools.includes(name)) fail(`alias/probe references an unreviewed tool: ${name}`);
    }
    byId.set(definition.id, definition);
  }
  return { byId, byTool };
}

const registry = createRegistry(platformDefinitions);
export function getPlatform(id: string): PlatformDefinition {
  const definition = registry.byId.get(id);
  if (!definition) throw new LmsError('UNSUPPORTED_PLATFORM', 'Unknown platform. Only built-in reviewed integrations are available.');
  return definition;
}
export function toolPlatform(name: string): PlatformId | undefined {
  return registry.byTool.get(name)?.id as PlatformId | undefined;
}
export function isPlatformEnvironment(key: string): boolean {
  return platformDefinitions.some(p => p.environmentPrefixes.some(prefix => key.startsWith(prefix)));
}
