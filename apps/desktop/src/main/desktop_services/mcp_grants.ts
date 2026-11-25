import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomicSync, type UserConfig } from '@weq/service';
import { z } from 'zod/v3';
import { mcpCredentialId } from './mcp_gateway';

const grantSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(64),
  configIds: z.array(z.string()).max(256),
  writeConfigIds: z.array(z.string()).max(256).default([]),
});
type McpGrant = z.infer<typeof grantSchema>;

const mcpAccountPermission = z.enum(['none', 'read', 'operate']);
export type McpAccountPermission = z.infer<typeof mcpAccountPermission>;
export const mcpGrantInput = z.union([
  grantSchema.pick({ id: true }).extend({
    configId: z.string(),
    permission: mcpAccountPermission,
  }),
  grantSchema.pick({ id: true, configIds: true, writeConfigIds: true }).partial({
    writeConfigIds: true,
  }),
]);

function setMembership(ids: string[], configId: string, enabled: boolean): string[] {
  if (ids.includes(configId) === enabled) return ids;
  return enabled ? [...ids, configId] : ids.filter((id) => id !== configId);
}

export class McpGrants {
  private readonly path: string;
  private grants: McpGrant[];

  constructor(root: string) {
    this.path = join(root, 'desktop-services', 'mcp-grants.json');
    if (existsSync(this.path)) {
      this.grants = z.array(grantSchema).parse(JSON.parse(readFileSync(this.path, 'utf8')));
      return;
    }
    this.grants = [];
    const instances = join(root, 'instances');
    if (!existsSync(instances)) return;
    for (const entry of readdirSync(instances, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f\d]{24}$/.test(entry.name)) continue;
      const path = join(instances, entry.name, 'data', 'config.json');
      if (!existsSync(path)) continue;
      const config = JSON.parse(readFileSync(path, 'utf8')) as UserConfig;
      const token = config?.settings?.mcp?.token;
      if (!token) continue;
      const id = mcpCredentialId(token);
      if (!this.grants.some((grant) => grant.id === id))
        this.grants.push({
          id,
          label: `旧窗口令牌 ${this.grants.length + 1}`,
          configIds: [],
          writeConfigIds: [],
        });
    }
    if (this.grants.length) this.save(this.grants);
  }

  private save(grants: McpGrant[]): void {
    writeFileAtomicSync(this.path, JSON.stringify(grants));
    this.grants = grants;
  }

  list(primary: string): (McpGrant & { primary?: true })[] {
    if (!primary) return this.grants;
    const id = mcpCredentialId(primary);
    const grant = this.grants.find((item) => item.id === id);
    return [
      {
        id,
        label: '默认令牌',
        configIds: grant?.configIds ?? [],
        writeConfigIds: grant?.writeConfigIds ?? [],
        primary: true,
      },
      ...this.grants.filter((item) => item.id !== id),
    ];
  }

  set(primary: string, id: string, configIds: string[], writeConfigIds?: string[]): void {
    const grant = this.list(primary).find((item) => item.id === id);
    if (!grant) throw new Error('此 MCP 令牌已失效。');
    this.saveGrant(grant, configIds, writeConfigIds ?? grant.writeConfigIds);
  }

  setAccountPermission(
    primary: string,
    id: string,
    configId: string,
    permission: McpAccountPermission,
  ): boolean {
    const grant = this.list(primary).find((item) => item.id === id);
    if (!grant) throw new Error('此 MCP 令牌已失效。');
    const configIds = setMembership(grant.configIds, configId, permission !== 'none');
    const writeConfigIds = setMembership(grant.writeConfigIds, configId, permission === 'operate');
    if (configIds === grant.configIds && writeConfigIds === grant.writeConfigIds) return false;
    this.saveGrant(grant, configIds, writeConfigIds);
    return true;
  }

  private saveGrant(grant: McpGrant, configIds: string[], writeConfigIds: string[]): void {
    if (configIds.length > 256) throw new Error('每个 MCP 令牌最多可授权 256 个账号数据源。');
    const writes = writeConfigIds.filter((configId) => configIds.includes(configId));
    this.save([
      ...this.grants.filter((item) => item.id !== grant.id),
      { ...grant, configIds, writeConfigIds: writes },
    ]);
  }

  create(label: string): string {
    const token = randomBytes(32).toString('hex');
    this.save([
      ...this.grants,
      { id: mcpCredentialId(token), label, configIds: [], writeConfigIds: [] },
    ]);
    return token;
  }

  remove(id: string): void {
    this.save(this.grants.filter((item) => item.id !== id));
  }

  rotate(previous: string, next: string): void {
    if (!previous || previous === next) return;
    const old = mcpCredentialId(previous);
    const moved = this.grants.find((item) => item.id === old);
    if (moved)
      this.save(
        this.grants.map((grant) =>
          grant.id === old ? { ...grant, id: mcpCredentialId(next) } : grant,
        ),
      );
  }
}
