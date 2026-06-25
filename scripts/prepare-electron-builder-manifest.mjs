import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(repoRoot, 'apps', 'desktop');
const appPkgPath = join(appDir, 'package.json');
const releasePkgPath = join(appDir, 'package.release.json');

const WORKSPACE_PREFIX = '@weq/';

const pkg = JSON.parse(readFileSync(appPkgPath, 'utf8'));
const dependencies = Object.fromEntries(
  Object.entries(pkg.dependencies ?? {}).filter(([name]) => !name.startsWith(WORKSPACE_PREFIX))
);

const releasePkg = {
  ...pkg,
  dependencies,
};

writeFileSync(releasePkgPath, JSON.stringify(releasePkg, null, 2) + '\n');

console.log(`wrote ${releasePkgPath}`);
console.log(
  `removed workspace runtime deps: ${Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith(WORKSPACE_PREFIX)).join(', ')}`
);
