import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'apps', 'desktop');
const appPkgPath = join(appDir, 'package.json');
const releasePkgPath = join(appDir, 'package.release.json');

const WORKSPACE_PREFIX = '@weq/';

export function releaseDesktopManifest(pkg) {
  return {
    ...pkg,
    dependencies: Object.fromEntries(
      Object.entries(pkg.dependencies ?? {}).filter(([name]) => !name.startsWith(WORKSPACE_PREFIX)),
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(appPkgPath, 'utf8'));
  writeFileSync(releasePkgPath, `${JSON.stringify(releaseDesktopManifest(pkg), null, 2)}\n`);
  console.log(`wrote ${releasePkgPath}`);
  console.log(
    `removed workspace runtime deps: ${Object.keys(pkg.dependencies ?? {})
      .filter((name) => name.startsWith(WORKSPACE_PREFIX))
      .join(', ')}`,
  );
}
