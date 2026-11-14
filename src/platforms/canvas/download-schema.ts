import { z } from 'zod';

export const CanvasDownloadShape = {
  file_id: z.number().int().positive().describe('Canvas file ID from course files, modules, or a linked page'),
  directory: z.string().min(1).describe('Absolute local directory in which to save the original file'),
  filename: z.string().min(1).optional().describe('Optional filename only, without a directory'),
  on_conflict: z.enum(['rename', 'error']).default('rename').describe('Preserve existing files; rename the new file by default'),
  max_bytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(512 * 1024 * 1024).describe('Maximum download bytes; default 512 MiB, maximum 1 GiB'),
};
