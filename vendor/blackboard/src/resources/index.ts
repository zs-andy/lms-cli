import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../tools/helpers.js';
import { courseLabel, displayName, fileDetailOf } from '../client/index.js';
import { toBlackboardError } from '../lib/errors.js';
import { handlerLabel } from '../tools/content.js';

/**
 * Resources expose stable, addressable snapshots that a client can attach as
 * context without the model having to call a tool first.
 *
 * They are deliberately limited to cheap, high-value reads: the identity, the
 * course list, and a per-course outline. Anything that needs parameters beyond
 * a course id, or that costs many requests, stays a tool.
 */
export function registerResources(server: McpServer): void {
  server.registerResource(
    'me',
    'blackboard://me',
    {
      title: 'My Blackboard profile',
      description: 'The signed-in user and the configured instance.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const client = await getClient();
        const me = await client.whoami();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  instance: client.config.baseUrl,
                  label: client.config.label,
                  userId: me.id,
                  displayName: displayName(me),
                  userName: me.userName,
                  studentId: me.studentId,
                  email: me.emailAddress,
                  department: me.department,
                  roles: me.insRoles,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResource(uri.href, err);
      }
    },
  );

  server.registerResource(
    'courses',
    'blackboard://courses',
    {
      title: 'My Blackboard courses',
      description: 'Every course the signed-in user is enrolled in, with ids and terms.',
      mimeType: 'application/json',
    },
    async (uri) => {
      try {
        const client = await getClient();
        const memberships = await client.listCourses({});
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                memberships.map((m) => ({
                  courseId: m.course?.id ?? m.courseId,
                  name: courseLabel(m.course),
                  code: m.course?.displayId ?? m.course?.courseId,
                  term: m.course?.term?.name,
                  role: m.courseRole?.courseName ?? m.role,
                  available: m.course?.isAvailable !== false,
                  isOrganization: m.course?.isOrganization === true,
                  lastAccess: m.lastAccessDate,
                })),
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResource(uri.href, err);
      }
    },
  );

  server.registerResource(
    'course-outline',
    new ResourceTemplate('blackboard://course/{courseId}/outline', { list: undefined }),
    {
      title: 'Course outline',
      description:
        'The full content tree of one course as JSON, with every item\'s path, type and attached file.',
      mimeType: 'application/json',
    },
    async (uri, { courseId }) => {
      try {
        const client = await getClient();
        const id = String(courseId);
        const [name, nodes] = await Promise.all([
          client.courseName(id),
          client.walkContents(id, { maxNodes: 600 }),
        ]);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                {
                  courseId: id,
                  course: name,
                  itemCount: nodes.length,
                  items: nodes.map((c) => {
                    const file = fileDetailOf(c);
                    return {
                      contentId: c.id,
                      title: c.title,
                      path: c._path,
                      depth: c._depth,
                      type: handlerLabel(c.contentHandler),
                      handler: c.contentHandler,
                      visibility: c.visibility,
                      file: file
                        ? {
                            fileName: file.fileName,
                            mimeType: file.mimeType,
                            fileSize: file.fileSize,
                          }
                        : undefined,
                    };
                  }),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return errorResource(uri.href, err);
      }
    },
  );
}

/**
 * Resource reads cannot signal `isError` the way tools can, so a failure is
 * returned as a JSON body carrying the code and hint. That keeps the guidance
 * ("run auth login") visible instead of collapsing into a protocol error.
 */
function errorResource(uri: string, err: unknown) {
  const be = toBlackboardError(err);
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ error: be.code, message: be.message, hint: be.hint }, null, 2),
      },
    ],
  };
}
