import { networkFetch } from '@weq/network';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { getReleaseFeed } from './release_feed';

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.literal(false),
  prerelease: z.boolean(),
  assets: z.array(
    z.object({
      name: z.string(),
      state: z.literal('uploaded'),
      digest: z.string().nullable().optional(),
      size: z.number().int().positive(),
    }),
  ),
});
export interface OfficialArchive {
  sha256: string;
  size: number;
}

/** CDN 只负责传输，资产身份来自官方 Release API。 */
export function officialArchive(
  data: unknown,
  version: string,
  fileName: string,
  includePrerelease = false,
): OfficialArchive {
  const release = releaseSchema.parse(data);
  if (release.prerelease && !includePrerelease) throw new Error('未开启检查测试版');
  if (release.tag_name !== `v${version}` && release.tag_name !== version)
    throw new Error('官方 Release 版本与更新包不一致');
  const matches = release.assets.filter((item) => item.name === fileName);
  const asset = matches.length === 1 ? matches[0] : undefined;
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''))
    throw new Error('官方 Release 缺少此架构更新包的 SHA-256，未安装；请稍后重试或手动下载。');
  return { sha256: asset.digest!.slice(7), size: asset.size };
}
export async function fetchOfficialArchive(
  version: string,
  fileName: string,
  includePrerelease = false,
): Promise<OfficialArchive> {
  const feed = getReleaseFeed('weq-devs/WeQ');
  let asset = await feed.archive(version, fileName);
  if (!asset) {
    await feed.read();
    asset = await feed.archive(version, fileName);
  }
  if (asset) {
    if (asset.prerelease && !includePrerelease) throw new Error('未开启检查测试版');
    return { sha256: asset.sha256, size: asset.size };
  }
  const response = await networkFetch(
    `https://api.github.com/repos/weq-devs/WeQ/releases/tags/v${encodeURIComponent(version)}`,
    {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
      headers: { Accept: 'application/vnd.github+json' },
    },
  );
  if (!response.ok)
    throw new Error(`无法核验官方 Release（HTTP ${response.status}），未安装；请稍后重试。`);
  return officialArchive(await response.json(), version, fileName, includePrerelease);
}
export async function verifyOfficialArchive(path: string, expected: OfficialArchive) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== expected.size)
    throw new Error('更新包大小与官方 Release 不一致');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256)
    throw new Error('更新包与官方 SHA-256 不匹配，未安装');
}
