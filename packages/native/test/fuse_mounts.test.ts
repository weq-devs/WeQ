/**
 * 「root 读不到的 FUSE 挂载」判定测试 —— 只喂 /proc/self/mounts 样本，
 * 不依赖真实挂载。
 *
 * 背景：AppImage 的 payload 挂在 `/tmp/.mount_xxx`（fuse，不带 allow_other），
 * root 对里面所有文件都是 EACCES —— 提权跑 worker 的注入路走不通，得换
 * 「临时放开 yama 保护」那条（见 apps/desktop/src/main/inject_elevation.ts）。
 * 判定错了的代价是两个方向都疼：漏判 → 又报那句 `权限不够`；误判 → 本来能
 * 用的提权 worker 被跳过。
 */

import { describe, expect, it } from 'vitest';
import { isOnPrivateFuseMount } from '../src/linux/fuse_mounts';

const MOUNTS = [
  '/dev/nvme0n1p3 / ext4 rw,relatime 0 0',
  'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
  'weQ-1.0.1-linux-x86_64.AppImage /tmp/.mount_weQ-1.lfXf82 fuse.weQ-1.0.1-linux-x86_64.AppImage ro,nosuid,nodev,relatime,user_id=1001,group_id=1001 0 0',
  'gocryptfs /home/u/secret fuse.gocryptfs rw,nosuid,nodev,relatime,user_id=1001,group_id=1001 0 0',
  'sshfs /home/u/remote fuse.sshfs rw,nosuid,nodev,allow_other 0 0',
  'somefs /home/u/asroot fuse.somefs rw,nosuid,nodev,user_id=0,group_id=0 0 0',
  '/dev/sda1 /mnt/my\\040disk ext4 rw,relatime 0 0',
  '',
].join('\n');

function on(path: string): boolean {
  return isOnPrivateFuseMount(path, MOUNTS);
}

describe('isOnPrivateFuseMount', () => {
  it('AppImage 挂载点里的路径（payload / worker / 原生模块）→ root 读不到', () => {
    expect(on('/tmp/.mount_weQ-1.lfXf82/@weqdesktop')).toBe(true);
    expect(on('/tmp/.mount_weQ-1.lfXf82/resources/app.asar')).toBe(true);
    expect(on('/tmp/.mount_weQ-1.lfXf82/native/linux/x64/nt_helper.node')).toBe(true);
  });

  it('取最长挂载点：/tmp 是 tmpfs，但真正盖住的是更长的 fuse 挂载点', () => {
    // 这条是本判定的核心 —— 只看「第一个匹配」会误判成 tmpfs（可读）。
    expect(on('/tmp/weQ/weq')).toBe(false);
  });

  it('普通 ext4 / tmpfs 上的安装 → 不受影响', () => {
    expect(on('/opt/weQ/weq')).toBe(false);
    expect(on('/')).toBe(false);
  });

  it('单用户 FUSE 家目录 → 同样判定为 root 不可见', () => {
    expect(on('/home/u/secret/weQ/weq')).toBe(true);
  });

  it('开了 allow_other 的 FUSE → root 读得到，不换路', () => {
    expect(on('/home/u/remote/weQ/weq')).toBe(false);
  });

  it('root 自己挂的 FUSE（user_id=0）→ root 读得到', () => {
    expect(on('/home/u/asroot/weq')).toBe(false);
  });

  it('前缀相近但不在挂载点内 → 不算（/tmp/.mount_xxxother 不是 /tmp/.mount_xxx 的子目录）', () => {
    expect(on('/tmp/.mount_weQ-1.lfXf82other/x')).toBe(false);
  });

  it('带八进制转义的挂载点（含空格）能正确解码', () => {
    expect(on('/mnt/my disk/weq')).toBe(false); // ext4，可读
  });

  it('mount 表读不到 / 为空 → 保守返回 false（退回原提权方式）', () => {
    expect(isOnPrivateFuseMount('/opt/weq', '')).toBe(false);
  });
});
