import { z } from 'zod';

export const agentLabModelSelectionSchema = z.union([
  z
    .object({
      providerId: z.string().trim().min(1),
      model: z.string().trim().min(1),
      useDefault: z.never().optional(),
    })
    .transform(({ providerId, model }) => ({ providerId, model })),
  z.object({ useDefault: z.literal(true) }).strict(),
]);
