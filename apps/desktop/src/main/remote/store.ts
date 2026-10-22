import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Claim } from './pairing';
import { remoteConnectionMode } from '../../shared/remote_bootstrap';

const savedSchema = z.object({
  enabled: z.boolean(),
  mode: remoteConnectionMode,
  tailscaleEnabled: z.boolean().default(false),
  networkIdentity: z
    .string()
    .regex(/^network-[0-9]+$/)
    .optional(),
  claims: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(64),
        tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
        approvedAt: z.number().finite(),
        lastSeenAt: z.number().finite().nullable(),
        scope: z.enum(['status:read', 'web:access']),
      }),
    )
    .max(16),
});

export class RemoteStore {
  private data: z.infer<typeof savedSchema>;
  private path: string;
  constructor(private readonly directory: string) {
    this.path = join(directory, 'devices.json');
    this.data = existsSync(this.path)
      ? savedSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : { enabled: false, mode: 'lan', tailscaleEnabled: false, claims: [] };
  }
  read() {
    return this.data;
  }
  claims(): Claim[] {
    return this.data.claims.map((claim) => ({ ...claim, code: '', expiresAt: 0 }));
  }
  save(update: Partial<z.infer<typeof savedSchema>>) {
    const next = savedSchema.parse({ ...this.data, ...update });
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${this.path}.tmp`, this.path);
    this.data = next;
  }
}
