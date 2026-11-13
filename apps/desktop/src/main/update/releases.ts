import semver from 'semver';
import { z } from 'zod';

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    assets: z.array(z.object({ name: z.string() })),
  }),
);

export function selectUpdateRelease(data: unknown, includePrerelease: boolean, manifest: string) {
  const releases = releasesSchema.parse(data).flatMap((release) => {
    const version = semver.valid(release.tag_name);
    if (!version || release.draft || !release.published_at) return [];
    if (!includePrerelease && (release.prerelease || semver.prerelease(version))) return [];
    const names = ['latest', 'beta', 'alpha', 'rc'].map((channel) => ({
      channel,
      name: manifest.replace(/^latest/, channel),
    }));
    const file = names.find(({ name }) => release.assets.some((asset) => asset.name === name));
    return file
      ? [{ tag: release.tag_name, version, manifest: file.name, channel: file.channel }]
      : [];
  });
  const selected = releases.sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (!selected) throw new Error('未找到当前平台可用的发布版本');
  return selected;
}

export async function resolveUpdateRelease(includePrerelease: boolean, manifest: string) {
  const response = await fetch('https://api.github.com/repos/weq-devs/WeQ/releases?per_page=100', {
    signal: AbortSignal.timeout(8000),
    redirect: 'error',
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`无法读取发布版本（HTTP ${response.status}），请稍后重试`);
  return selectUpdateRelease(await response.json(), includePrerelease, manifest);
}
