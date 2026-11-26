import { z } from 'zod';

export const BlackboardDownloadShape = {
  courseId: z.string().min(1).describe('Blackboard course ID, e.g. "_12345_1"'),
  contentId: z.string().min(1).describe('Blackboard content item ID holding the file (from bb_list_files or bb_list_content)'),
  directory: z.string().min(1).describe('Absolute local directory in which to save the original file'),
  source_file: z.string().min(1).optional().describe('When the content item has several files, pick one by filename substring'),
  filename: z.string().min(1).optional().describe('Optional destination filename only, without a directory'),
  on_conflict: z.enum(['rename', 'error']).default('rename').describe('Preserve existing files; rename the new file by default'),
  max_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(512 * 1024 * 1024).describe('Maximum download bytes; default 512 MiB, maximum 1 GiB'),
};
