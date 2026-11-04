import { z } from 'zod';
const value = z.union([z.null(), z.number().finite(), z.string()]);
export const sourceSearchRequest = z.object({
  target: z.object({
    dbPath: z.string().min(1).max(4096),
    key: z.string().max(1024).optional(),
    algo: z
      .object({ pageHmacAlgorithm: z.string().max(64), kdfHmacAlgorithm: z.string().max(64) })
      .optional(),
  }),
  sql: z.string().min(1).max(32768),
  params: z.array(value).max(1000),
});
export const sourceSearchResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rows: z.array(z.array(value).max(64)).max(1000) }),
  z.object({ ok: z.literal(false), error: z.string().max(8192) }),
]);
