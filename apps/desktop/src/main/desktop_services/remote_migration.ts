import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger, writeFileAtomicSync } from '@weq/service';
import { savedInstanceAccounts } from '../account_instances';
import { RemoteStore } from '../remote/store';

export function migrateRemoteDevices(dataRoot: string, remoteDirectory: string): void {
  const receipt = join(remoteDirectory, 'account-scope-migration.json');
  if (existsSync(receipt)) return;
  const windows = join(dataRoot, 'instances');
  if (!existsSync(windows)) return;
  try {
    const main = new RemoteStore(remoteDirectory);
    const devices = main.read().claims.slice();
    const ids = new Set(devices.map((claim) => claim.id));
    const hashes = new Set(devices.map((claim) => claim.tokenHash));
    for (const entry of readdirSync(windows, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f\d]{24}$/.test(entry.name)) continue;
      const profile = join(windows, entry.name);
      const old = join(profile, 'electron', 'remote-network');
      if (!existsSync(join(old, 'devices.json'))) continue;
      const accounts = savedInstanceAccounts(join(profile, 'data'));
      const account = accounts.length === 1 ? accounts[0] : undefined;
      for (const claim of new RemoteStore(old).read().claims) {
        if (ids.has(claim.id) || hashes.has(claim.tokenHash) || devices.length >= 16) continue;
        ids.add(claim.id);
        hashes.add(claim.tokenHash);
        devices.push({
          ...claim,
          accountConfigIds: claim.scope === 'web:access' && account ? [account.configId] : [],
        });
      }
    }
    if (devices.length !== main.read().claims.length) main.save({ claims: devices });
    writeFileAtomicSync(receipt, JSON.stringify({ version: 1, preservedDevices: devices.length }));
  } catch (error) {
    getLogger().warn('旧 Remote 配对迁移未完成，已保留原件', { error: String(error) });
  }
}
