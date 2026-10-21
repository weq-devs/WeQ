/**
 * 「b_ 和 s_ 哪个新就取哪个」—— 换头像后 QQ 常常只刷新缩略图，大图会停在旧版本，
 * 所以解析时不能无条件优先 `b_`。这里用真实目录结构（bucket/平铺/temp）覆盖三种情形。
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  AVATAR_VARIANT_STALE_MS,
  AvatarResourceService,
  avatarHashForUid,
} from '../src/account/avatar_resource';

const UID = 'u_joc8nYBNYGrXB-8xnCZDRg';
const HASH = avatarHashForUid(UID);
const BUCKET = HASH.slice(0, 2);

let root = '';
let service: AvatarResourceService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weq-avatar-freshness-'));
  await mkdir(join(root, 'avatar', 'user', BUCKET), { recursive: true });
  service = new AvatarResourceService(
    { context: { uin: '10001' }, uidMap: { uidByUin: () => UID } } as never,
    { ntDataDir: () => root } as never,
  );
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** 写一个变体文件并把 mtime 定到指定时间。 */
async function put(variant: 'b' | 's', at: Date, body = variant) {
  const path = join(root, 'avatar', 'user', BUCKET, `${variant}_${HASH}`);
  await writeFile(path, body);
  await utimes(path, at, at);
  return path;
}

const old = new Date('2026-08-23T00:00:00Z');
const mid = new Date('2026-10-17T00:00:00Z');

it('大图更新时照旧取大图，不标记过期', async () => {
  const big = await put('b', mid);
  await put('s', old);
  const hit = await service.resolveByUidFile('user', UID, 'big');
  expect(hit).toMatchObject({ path: big, variant: 'big', stale: false });
});

it('缩略图明显更新（换过头像）时取缩略图并标记 stale', async () => {
  await put('b', old);
  const small = await put('s', mid);
  const hit = await service.resolveByUidFile('user', UID, 'big');
  expect(hit).toMatchObject({ path: small, variant: 'small', stale: true });
  expect(hit!.mtimeMs).toBeCloseTo(mid.getTime(), -3);
});

it('两者相差不到一天视为同一张图，仍取大图', async () => {
  const big = await put('b', new Date(mid.getTime() - AVATAR_VARIANT_STALE_MS + 60_000));
  await put('s', mid);
  const hit = await service.resolveByUidFile('user', UID, 'big');
  expect(hit).toMatchObject({ path: big, variant: 'big', stale: false });
});

it('只请求缩略图时不会升级成大图', async () => {
  await put('b', mid);
  const small = await put('s', old);
  const hit = await service.resolveByUidFile('user', UID, 'small');
  expect(hit).toMatchObject({ path: small, variant: 'small', stale: false });
});

it('请求的变体缺失时退回另一个，不算过期', async () => {
  const small = await put('s', mid);
  const hit = await service.resolveByUidFile('user', UID, 'big');
  expect(hit).toMatchObject({ path: small, variant: 'small', stale: false });
});

it('uin 入口同样走新逻辑（group 的 uin 就是 uid）', async () => {
  await mkdir(join(root, 'avatar', 'group', BUCKET), { recursive: true });
  const groupHash = avatarHashForUid('8029');
  const dir = join(root, 'avatar', 'group', groupHash.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const big = join(dir, `b_${groupHash}`);
  const small = join(dir, `s_${groupHash}`);
  await writeFile(big, 'b');
  await utimes(big, old, old);
  await writeFile(small, 's');
  await utimes(small, mid, mid);
  const hit = await service.resolveByUinFile('group', '8029', 'big');
  expect(hit).toMatchObject({ path: small, variant: 'small', stale: true });
});
