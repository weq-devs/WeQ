/**
 * Guard: the modules the web app reuses from `apps/desktop/src/main` must not
 * pull in `electron`, transitively or otherwise.
 *
 * This broke twice while building the web app — first via
 * `app_context → qq_protocol`, then via the protocol handlers sharing a file
 * with their `protocol.handle` registration. Both were only caught at runtime,
 * as an opaque "does not provide an export named 'app'". This walks the real
 * import graph so the next regression fails loudly at build time instead.
 *
 * Run: npx tsx apps/web/scripts/check-electron-free.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const DESKTOP_MAIN = join(REPO_ROOT, 'apps/desktop/src/main');

/** The entry points `apps/web/src/server` imports from the desktop app. */
const ENTRIES = [
  'context/app_context.ts',
  'ipc/router.ts',
  'media_protocol.ts',
  'avatar_protocol.ts',
  'resource_protocol.ts',
  'file_response.ts',
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(source);
    while (m !== null) {
      if (m[1]) out.push(m[1]);
      m = re.exec(source);
    }
  }
  return out;
}

/** Resolve a relative specifier to a real .ts file, or null for packages. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

const seen = new Set<string>();
const offenders: Array<{ file: string; via: string[] }> = [];

function walk(file: string, trail: string[]): void {
  if (seen.has(file)) return;
  seen.add(file);

  const source = readFileSync(file, 'utf8');
  const specs = specifiersOf(source);

  if (specs.includes('electron')) {
    offenders.push({ file, via: [...trail, file] });
  }

  for (const spec of specs) {
    const next = resolveLocal(file, spec);
    if (next) walk(next, [...trail, file]);
  }
}

const rel = (p: string): string => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');

for (const entry of ENTRIES) {
  const path = join(DESKTOP_MAIN, entry);
  if (!existsSync(path)) {
    console.error(`FAIL  entry not found: ${entry}`);
    process.exit(1);
  }
  walk(path, []);
}

if (offenders.length > 0) {
  console.error(
    `\nFAIL  ${offenders.length} module(s) reachable from the web app import 'electron':\n`,
  );
  for (const { via } of offenders) {
    console.error(`  ${via.map(rel).join('\n    → ')}\n`);
  }
  console.error('Split the Electron-only part into its own module (see protocol_register.ts).\n');
  process.exit(1);
}

console.log(`PASS  ${seen.size} modules reachable from apps/web are electron-free`);
