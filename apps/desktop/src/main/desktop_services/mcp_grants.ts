import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomicSync, type UserConfig } from '@weq/service';
import { z } from 'zod';
import { mcpCredentialId } from './mcp_gateway';

const grantSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(64),
  configIds: z.array(z.string()).max(256),
});
type McpGrant = z.infer<typeof grantSchema>;

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
        this.grants.push({ id, label: `旧窗口令牌 ${this.grants.length + 1}`, configIds: [] });
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
      { id, label: '默认令牌', configIds: grant?.configIds ?? [], primary: true },
      ...this.grants.filter((item) => item.id !== id),
    ];
  }

  set(primary: string, id: string, configIds: string[]): void {
    const grant = this.list(primary).find((item) => item.id === id);
    if (!grant) throw new Error('此 MCP 令牌已失效。');
    this.save([...this.grants.filter((item) => item.id !== id), { ...grant, configIds }]);
  }

  create(label: string): string {
    const token = randomBytes(32).toString('hex');
    this.save([...this.grants, { id: mcpCredentialId(token), label, configIds: [] }]);
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
