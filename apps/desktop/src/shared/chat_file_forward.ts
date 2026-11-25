import { z } from 'zod/v3';

const msgId = z.string().regex(/^\d{1,20}$/);

export const chatFileForwardInput = z.object({
  kind: z.literal('chat-file'),
  msgId,
  name: z.string().min(1).max(1024),
  token: z.string().max(4096),
  conv: z.string().min(1).max(256),
  fwdMsgId: msgId.optional(),
  fwdKind: z.enum(['c2c', 'group']).optional(),
  fwdResId: z.string().max(4096).optional(),
});

export type ChatFileForwardSource = z.infer<typeof chatFileForwardInput>;
