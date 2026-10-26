import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function fingerprint(path, label) {
  try {
    const before = await stat(path);
    if (!before.isFile()) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const after = await stat(path);
    const stable = before.size === after.size && before.mtimeMs === after.mtimeMs;
    return {
      label,
      bytes: after.size,
      modifiedAt: after.mtime.toISOString(),
      stable,
      sha256: stable ? hash.digest('hex') : null,
    };
  } catch {
    return { label, available: false };
  }
}
async function nativeFiles(dir, depth = 0) {
  if (depth > 4) return [];
  try {
    const found = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= 32) break;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...(await nativeFiles(path, depth + 1)));
      else if (entry.isFile() && entry.name.endsWith('.node')) found.push(path);
    }
    return found.slice(0, 32);
  } catch {
    return [];
  }
}
const processes =
  process.platform === 'win32'
    ? null
    : execFileSync('ps', ['-axo', 'pid=,lstart=,comm='], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'Asia/Shanghai' },
      })
        .split('\n')
        .flatMap((line) => {
          const match = /^\s*(\d+)\s+(.{24})\s+(.+)$/.exec(line);
          if (!match || !/(?:WeQ|weq|Electron)(?:\.app| Helper|$)/.test(match[3])) return [];
          return [
            {
              pid: Number(match[1]),
              startedAtRaw: match[2].trim(),
              timeZone: 'Asia/Shanghai',
              executable: basename(match[3]),
            },
          ];
        });
const files = [
  ['main', join(root, 'apps/desktop/out/main/index.js')],
  ['preload', join(root, 'apps/desktop/out/preload/index.js')],
  ['preload-esm', join(root, 'apps/desktop/out/preload/index.mjs')],
  ['renderer-index', join(root, 'apps/desktop/out/renderer/index.html')],
  ...(await nativeFiles(join(root, 'native'))).map((path, index) => [
    `native-candidate-${index + 1}`,
    path,
  ]),
];
const snapshot = {
  schemaVersion: 1,
  sampledAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  workingTreeDirty: Boolean(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  ),
  processes,
  artifactCandidates: await Promise.all(files.map(([label, path]) => fingerprint(path, label))),
  loadedMainIdentity: null,
  loadedPreloadIdentity: null,
  loadedRendererIdentity: null,
  loadedNativeIdentity: null,
  notes: [
    '进程与磁盘候选不能证明当前已加载的模块；不读取聊天库，不连接 QQ，不重启或 GC。',
    'mtime 采用原始 ISO 字段；进程 startedAtRaw 明确按北京时间采集。',
  ],
};
const serialized = JSON.stringify(snapshot, null, 2);
if (process.argv[2]) {
  const output = resolve(process.argv[2]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${serialized}\n`, { flag: 'wx', mode: 0o600 });
}
console.log(serialized);
