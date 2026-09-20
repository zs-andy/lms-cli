import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, guard, text, table, clip } from './helpers.js';
import { BlackboardError } from '../lib/errors.js';
import { DEFAULT_ENDPOINTS, loadEndpoints } from '../client/endpoints.js';

/**
 * Path prefixes the raw tool may reach.
 *
 * The point of the escape hatch is to reach Blackboard API surfaces this
 * package has not modelled yet, not to turn the session into a general web
 * client. Restricting to API prefixes keeps the blast radius to JSON endpoints
 * on the user's own instance (the HTTP client separately enforces the host
 * allowlist, so cookies can never be sent off-tenant).
 */
const ALLOWED_PREFIXES = [
  '/learn/api/v1/',
  '/learn/api/v2/',
  '/learn/api/public/v1/',
  '/learn/api/public/v2/',
  '/learn/api/public/v3/',
  '/institution/api/',
  '/foundations/',
];

function assertAllowedPath(path: string): void {
  if (/^https?:\/\//i.test(path)) {
    throw new BlackboardError('BAD_INPUT', 'Pass an instance-relative path, not a full URL.', {
      hint: 'For example "/learn/api/v1/users/me".',
    });
  }
  const normalised = path.startsWith('/') ? path : `/${path}`;
  // Reject traversal before prefix matching, so "/learn/api/v1/../.." cannot
  // escape the allowlist.
  if (normalised.includes('..')) {
    throw new BlackboardError('BAD_INPUT', 'Path traversal is not permitted.');
  }
  if (!ALLOWED_PREFIXES.some((p) => normalised.startsWith(p))) {
    throw new BlackboardError('BAD_INPUT', `Path must start with one of: ${ALLOWED_PREFIXES.join(', ')}`, {
      hint: 'To download a file use bb_download_file, which handles the /bbcswebdav redirect chain.',
    });
  }
}

export function registerRawTools(server: McpServer): void {
  server.registerTool(
    'bb_raw_request',
    {
      title: 'Call a Blackboard API endpoint directly',
      description:
        'Escape hatch: issues a request against any Blackboard API path using the stored session, and returns the raw JSON. Use this when no dedicated tool covers what you need. The Ultra internal API (/learn/api/v1/...) exposes far more than this server models. Call bb_list_endpoints first to see what is already wrapped.',
      inputSchema: {
        path: z
          .string()
          .describe('Instance-relative API path, e.g. "/learn/api/v1/courses/_12345_1/groups".'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .optional()
          .describe('Default GET. Anything else needs writes enabled.'),
        query: z
          .record(z.string())
          .optional()
          .describe('Query parameters as a flat object.'),
        body: z.unknown().optional().describe('JSON request body for non-GET methods.'),
        maxChars: z
          .number()
          .int()
          .min(200)
          .max(120_000)
          .optional()
          .describe('Truncate the response to this many characters. Default 15000.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    guard('bb_raw_request', async (args) => {
      assertAllowedPath(args.path);
      const client = await getClient();
      const method = args.method ?? 'GET';

      const res = await client.http.request({
        method,
        path: args.path,
        query: args.query,
        body: args.body,
        headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json;charset=UTF-8' },
        allowNotFound: true,
      });

      const raw = await res.body.text();
      const max = args.maxChars ?? 15_000;

      let rendered = raw;
      try {
        rendered = JSON.stringify(JSON.parse(raw), null, 1);
      } catch {
        /* not JSON; show as-is */
      }

      const truncated = rendered.length > max;
      return text(
        [
          `\`${method} ${args.path}\` -> HTTP ${res.status}`,
          '',
          '```json',
          truncated ? rendered.slice(0, max) : rendered,
          '```',
          truncated
            ? `\n_Truncated at ${max} of ${rendered.length} characters. Raise maxChars or narrow the query._`
            : '',
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'bb_batch_request',
    {
      title: 'Call several Blackboard endpoints at once',
      description:
        'Fans out up to 20 GET reads in a single round trip using Blackboard\'s own batch endpoint. Paths are version-relative, e.g. "v1/courses/_12345_1/groups". Much cheaper than repeated bb_raw_request calls when gathering the same data across many courses.',
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('Version-relative paths, e.g. ["v1/users/me", "v1/terms"].'),
        maxChars: z.number().int().min(200).max(120_000).optional().describe('Default 15000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    guard('bb_batch_request', async ({ paths, maxChars }) => {
      const client = await getClient();
      for (const p of paths) {
        if (p.includes('..') || /^https?:\/\//i.test(p)) {
          throw new BlackboardError('BAD_INPUT', `Invalid batch path: ${p}`, {
            hint: 'Use version-relative paths like "v1/users/me".',
          });
        }
      }

      const results = await client.batch(
        paths.map((p) => ({ method: 'GET' as const, relativeUrl: p.replace(/^\//, '') })),
      );

      const max = maxChars ?? 15_000;
      const budget = Math.floor(max / Math.max(paths.length, 1));

      const blocks = results.map((r, i) => {
        const body = JSON.stringify(r.body ?? null, null, 1);
        const cut = body.length > budget;
        return [
          `### ${paths[i]} -> HTTP ${r.status ?? r.code ?? '?'}`,
          '```json',
          cut ? body.slice(0, budget) : body,
          '```',
          cut ? `_truncated at ${budget} of ${body.length} chars_` : '',
        ].join('\n');
      });

      return text(blocks.join('\n\n'));
    }),
  );

  server.registerTool(
    'bb_list_endpoints',
    {
      title: 'List known Blackboard endpoints',
      description:
        'Shows every Blackboard API endpoint this server knows, with the operation name and its path template, plus any local overrides. Useful for discovering what to pass to bb_raw_request.',
      inputSchema: {
        filter: z.string().optional().describe('Case-insensitive substring filter.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard('bb_list_endpoints', async ({ filter }) => {
      const active = loadEndpoints();
      const needle = filter?.toLowerCase();
      const rows = Object.entries(active)
        .filter(([op, tmpl]) =>
          needle ? `${op} ${tmpl}`.toLowerCase().includes(needle) : true,
        )
        .map(([op, tmpl]) => ({
          operation: op,
          path: tmpl,
          overridden:
            tmpl !== DEFAULT_ENDPOINTS[op as keyof typeof DEFAULT_ENDPOINTS] ? 'yes' : undefined,
        }));

      return text(
        [
          `${rows.length} endpoint(s).`,
          '',
          table(rows),
          '',
          '_Pass any of these to `bb_raw_request` (substituting the `{placeholders}`), or use the dedicated tool where one exists._',
        ].join('\n'),
      );
    }),
  );

  // ── writes ──────────────────────────────────────────────────────────────

  server.registerTool(
    'bb_mark_reviewed',
    {
      title: 'Mark course content as reviewed',
      description:
        'Marks a reviewable content item as reviewed (the "Mark Reviewed" button in Ultra). Requires writes to be enabled with BLACKBOARD_MCP_ALLOW_WRITES=1; this server is read-only by default.',
      inputSchema: {
        courseId: z.string().describe('Course id, e.g. "_12345_1".'),
        contentId: z.string().describe('Content item id. Must be a reviewable item.'),
        reviewed: z.boolean().optional().describe('Default true; pass false to un-review.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    guard('bb_mark_reviewed', async ({ courseId, contentId, reviewed }) => {
      const client = await getClient();
      if (!client.config.allowWrites) {
        throw new BlackboardError('FORBIDDEN', 'Writes are disabled on this server.', {
          hint: 'Set BLACKBOARD_MCP_ALLOW_WRITES=1 in the MCP server environment to permit this.',
        });
      }
      await client.markReviewed(courseId, contentId, reviewed ?? true);
      return text(`Marked \`${contentId}\` as ${reviewed === false ? 'not reviewed' : 'reviewed'}.`);
    }),
  );
}
