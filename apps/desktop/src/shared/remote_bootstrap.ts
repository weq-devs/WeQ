import { z } from 'zod';

export const remoteConnectionMode = z.enum(['lan', 'existing', 'tailscale']);
export type RemoteConnectionMode = z.infer<typeof remoteConnectionMode>;

export function remoteDirectAddresses(
  addresses: readonly string[],
  mode: 'lan' | 'existing',
): string[] {
  return [...new Set(addresses)].filter((address) => {
    try {
      const url = new URL(address);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        return false;
      const parts = url.hostname.split('.');
      if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255))
        return false;
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      return mode === 'existing'
        ? a === 100 && b >= 64 && b <= 127
        : a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    } catch {
      return false;
    }
  });
}

// Key 的一次性、标签和有效期由 Tailscale 控制面决定，客户端只能检查格式。
export const remoteAuthKeySchema = z
  .string()
  .regex(/^tskey-auth-[A-Za-z0-9_-]{20,200}$/, '请输入有效的 Tailscale Auth Key。')
  .refine((value) => !/\s/.test(value), '入网密钥不能包含空白字符。');

export const remoteInviteInput = z
  .union([
    z
      .object({ authKey: remoteAuthKeySchema, singleUseConfirmed: z.literal(true).optional() })
      .strict(),
    z.object({ endpoint: z.string().url() }).strict(),
  ])
  .optional();
