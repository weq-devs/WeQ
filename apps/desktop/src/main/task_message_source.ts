import { z } from 'zod/v3';
import type { ExportMessageSource } from '@weq/service';

export const taskMessageSourceInput = z.object({
  kind: z.literal('conversation'),
  conversationKind: z.enum(['c2c', 'group']),
  conv: z.string().min(1).max(128),
  msgId: z.string().min(1).max(128),
  seq: z
    .string()
    .regex(/^[1-9]\d{0,19}$/)
    .optional(),
}) satisfies z.ZodType<ExportMessageSource>;
