import { z } from 'zod';

export const backupProbeInput = z.object({
  dirPath: z.string().min(1).max(4096),
  dbKey: z.string().max(1024).optional(),
  expectedUin: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  /** 本机 QQ 数据根下的 login.db；没有 gpro 库时用来查 uid。 */
  loginDbPaths: z.array(z.string().min(1).max(4096)).max(8).optional(),
});
export const backupProbeResult = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    dbKey: z.string().max(1024).optional(),
    mobile: z.boolean(),
    preview: z.object({
      uin: z.string().min(1).max(64),
      uid: z.string().max(256),
      displayName: z.string().max(4096),
      avatarUrl: z.string().max(4096),
    }),
  }),
  z.object({ status: z.literal('needKey') }),
  z.object({ status: z.literal('error'), error: z.string().max(8192) }),
]);
export type BackupProbeInput = z.infer<typeof backupProbeInput>;
export type BackupProbeResult = z.infer<typeof backupProbeResult>;
