import { z } from 'zod';
export const searchRetirementRequest = z.object({
  root: z.string().min(1).max(4096),
  table: z.enum(['buddy_msg_fts', 'group_msg_fts']),
  sourcePath: z.string().min(1).max(4096),
});
export const searchRetirementResponse = z.object({
  status: z.enum(['retired', 'absent', 'busy', 'unrecognized']),
});
