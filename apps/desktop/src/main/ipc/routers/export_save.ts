import { z } from 'zod';

export const exportSavePolicyInput = z.object({
  mode: z.enum(['preset', 'before', 'after']),
  directory: z.string().min(1).optional(),
});
