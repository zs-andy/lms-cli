import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * Prompts are the "front door" for a client's slash-command menu.
 *
 * Each one encodes a workflow that would otherwise need several tool calls in
 * the right order, so the model does not have to rediscover the sequence.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'whats_due',
    {
      title: "What's due",
      description: 'Summarise everything due soon across all Blackboard courses, grouped by urgency.',
      argsSchema: {
        days: z.string().optional().describe('How many days ahead to look. Default 14.'),
      },
    },
    ({ days }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Using the Blackboard tools, tell me what I have due in the next ${days ?? 14} days.`,
              '',
              'Steps:',
              `1. Call bb_todo with days=${days ?? 14} to get overdue, due-today and upcoming work.`,
              '2. If anything is overdue or due within 3 days, call bb_get_grade_detail on those items to check whether a submission already exists and what the instructions ask for.',
              '',
              'Then give me:',
              '- Anything overdue, flagged clearly, with whether I have submitted',
              '- What is due in the next 7 days, in date order',
              '- A short suggested order of work, reasoning about effort and deadline',
              '',
              'Be concrete. Name the course and the exact due date for each item. If nothing is due, say so plainly and mention that items without due dates set in the gradebook will not appear.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'course_briefing',
    {
      title: 'Brief me on a course',
      description: 'Build a full picture of one course: structure, deadlines, grades and recent activity.',
      argsSchema: {
        course: z.string().describe('Course name, code, or id (e.g. "_12345_1" or "Machine Learning").'),
      },
    },
    ({ course }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Give me a complete briefing on my Blackboard course "${course}".`,
              '',
              'Steps:',
              `1. Call bb_list_courses and identify the course matching "${course}". If several match, ask me which one before continuing.`,
              '2. Call bb_get_course for its details.',
              '3. Call bb_browse_course to map its content structure.',
              '4. Call bb_list_grades for that courseId.',
              '5. Call bb_announcements for that courseId.',
              '',
              'Then summarise:',
              '- What the course covers and how it is organised (weeks? modules? topics?)',
              '- Every graded item, what it is worth, and my current standing',
              '- Upcoming deadlines',
              '- Anything recently posted I should read',
              '- Where the key materials live (syllabus, slides, readings), with the contentIds so I can ask you to open them',
              '',
              'Lead with what needs my attention rather than an inventory.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'study_pack',
    {
      title: 'Assemble a study pack',
      description: 'Find and read all course material on a topic, then synthesise it into study notes.',
      argsSchema: {
        topic: z.string().describe('The topic, week, or exam to study for.'),
        course: z.string().optional().describe('Restrict to one course. Omit to search all.'),
      },
    },
    ({ topic, course }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Build me a study pack on "${topic}"${course ? ` from my course "${course}"` : ' from my Blackboard courses'}.`,
              '',
              'Steps:',
              course
                ? `1. Call bb_list_courses to resolve "${course}" to a courseId, then bb_search_content with that courseId and query="${topic}".`
                : `1. Call bb_search_content with query="${topic}" to find relevant material across my courses.`,
              '2. For the most relevant items, call bb_read_file to read the actual content. For long PDFs, page through with fromPage until you have the substance. Do not stop at page 1 and guess.',
              '3. Call bb_get_content on any non-file items (pages, assignment briefs) that look relevant.',
              '',
              'Then produce:',
              '- A synthesis of the key concepts, in a sensible teaching order',
              '- The definitions and formulas that appear in the material, quoted accurately',
              '- Worked examples if the material contains any',
              '- What the material suggests will be assessed',
              '- A list of the sources you actually read, with course and file names',
              '',
              'Ground everything in what the files actually say. If the material is thin or you could not read a key file (for example a scanned PDF with no text layer), say so explicitly rather than filling the gap from general knowledge.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'catch_up',
    {
      title: 'Catch me up',
      description: 'Everything that changed on Blackboard recently: posts, grades, new material, deadlines.',
      argsSchema: {
        days: z.string().optional().describe('How far back to look. Default 7.'),
      },
    },
    ({ days }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `I have been away from Blackboard for about ${days ?? 7} days. Catch me up.`,
              '',
              'Steps:',
              '1. Call bb_activity_stream for recent changes across courses.',
              '2. Call bb_announcements with unreadOnly=true for anything I have not read.',
              '3. Call bb_todo to see what is now due or overdue.',
              '4. Call bb_list_grades with gradedOnly=true to spot newly posted grades.',
              '',
              'Then tell me, in priority order:',
              '- Anything urgent (overdue, or due in the next 48 hours)',
              '- New grades and how they change my standing',
              '- Announcements I need to read, summarised',
              '- New material posted',
              '',
              'Keep it tight. I want to know what to act on, not a changelog.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'grade_report',
    {
      title: 'Grade report',
      description: 'Current standing across all courses, with feedback on what to prioritise.',
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Give me a full report on my academic standing from Blackboard.',
              '',
              'Steps:',
              '1. Call bb_grade_summary for per-course standing.',
              '2. Call bb_list_grades (all courses) for the item-level picture.',
              '3. For anything scoring poorly or carrying instructor feedback, call bb_get_grade_detail to read the actual feedback.',
              '',
              'Then tell me:',
              '- Where I stand in each course',
              '- Which courses need attention and why',
              '- What the instructor feedback actually says, and any pattern across it',
              '- What is still ungraded or unsubmitted',
              '',
              'Be straight with me about weak spots. Note explicitly that unweighted point averages may differ from a course\'s official weighted final grade.',
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'find_material',
    {
      title: 'Find course material',
      description: 'Locate a specific file, reading, or slide deck across all Blackboard courses.',
      argsSchema: {
        what: z.string().describe('What to look for, e.g. "the syllabus" or "lecture 4 slides".'),
      },
    },
    ({ what }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Find "${what}" in my Blackboard courses.`,
              '',
              'Steps:',
              `1. Call bb_search_content with query terms drawn from "${what}". Try a couple of phrasings if the first returns nothing. Instructors name things inconsistently.`,
              '2. If that fails, call bb_list_courses then bb_list_files on the likely course to browse what is actually there.',
              '3. Once found, report the course, the folder path, and the contentId.',
              '',
              `Then ask whether I want you to read it (bb_read_file) or just download it (bb_download_file). If "${what}" is ambiguous or several things match, show me the candidates rather than picking one.`,
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
