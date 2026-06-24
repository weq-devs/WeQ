// Sync the release version from a pushed git tag (vX.Y.Z) into the root and
// desktop package.json files. electron-builder reads apps/desktop/package.json
// for the artifact version, and Electron's app.getVersion() returns it at
// runtime (shown on 设置 → 全局设置).
//
//   node scripts/set-version.mjs v1.2.3

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/set-version.mjs <tag, e.g. v1.2.3>');
  process.exit(1);
}

const version = raw.replace(/^v/, '').trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version "${version}" (from "${raw}"); expected x.y.z`);
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['package.json', 'apps/desktop/package.json'];

for (const rel of targets) {
  const file = join(repoRoot, rel);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`set ${rel} version -> ${version}`);
}
