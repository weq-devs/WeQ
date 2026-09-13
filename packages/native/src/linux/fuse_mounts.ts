/**
 * 「只有挂载者能访问」的 FUSE 挂载检测（linux）。
 *
 * AppImage 把 payload 用 libfuse 挂到 `/tmp/.mount_<name>.<rand>/` 再执行，
 * 挂载选项默认不带 `allow_other` —— 内核在 FUSE 层只放行 euid **和** egid 都
 * 等于挂载者的进程（`fuse_allow_current_process`），root(0:0) 会被 EACCES。
 * 于是任何「以 root 跑我们自己的二进制 / 读我们自己的 .node」的流程
 * （sudo 注入 worker 就是）在 AppImage 下必然失败，而报错只是一句
 * `env: "/tmp/.mount_xxx/@weqdesktop": 权限不够` —— 看起来像权限配置问题，
 * 实际是挂载语义问题。
 *
 * 同类还有用户把家目录 / 安装目录放在单用户 FUSE 上（gocryptfs、encfs、
 * 未开 allow_other 的 sshfs），root 一样读不到，只是路径不是 /tmp/.mount_*。
 *
 * 判定方式：在 `/proc/self/mounts` 里找覆盖 `path` 的**最长**挂载点，看它的
 * fstype 是不是 `fuse*`、选项里有没有 `allow_other`。取最长是必须的：
 * `/tmp` 通常是 tmpfs（root 读得到），真正盖住 AppImage payload 的是更长的
 * `/tmp/.mount_xxx`（fuse）。
 */

import { readFileSync } from 'node:fs';

/** mount 表里的八进制转义（`\040` = 空格，`\011` = tab，`\012` = 换行）。 */
function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** `dir` 是不是 `path` 的祖先目录（按路径分量比较，`/tmpfoo` 不算 `/tmp` 之内）。 */
function isAncestorDir(dir: string, path: string): boolean {
  if (dir === '/') return true;
  if (!path.startsWith(dir)) return false;
  return path.length === dir.length || path[dir.length] === '/';
}

/**
 * 这个 FUSE 挂载是不是「只有挂载者（及其同 euid/egid）能访问」。
 *
 * `user_id=0` 是 root 自己挂的，root 当然读得到，不算私有挂载。
 */
function isPrivateFuse(fstype: string, options: string[]): boolean {
  if (!fstype.startsWith('fuse')) return false;
  if (options.includes('allow_other')) return false;
  return !options.includes('user_id=0');
}

/**
 * `path` 是否落在「root 也读不到」的 FUSE 挂载上。
 *
 * @param mountsText 供测试注入 mount 表内容；默认读 `/proc/self/mounts`。
 *   读不到（非 linux / 受限环境）时保守返回 false —— 调用方会退回原来的
 *   提权方式，失败信息里仍有 {@link linuxSudoErrorHint} 兜底。
 */
export function isOnPrivateFuseMount(path: string, mountsText?: string): boolean {
  let text: string;
  try {
    text = mountsText ?? readFileSync('/proc/self/mounts', 'utf-8');
  } catch {
    return false;
  }

  let best: { dir: string; private: boolean } | null = null;
  for (const line of text.split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 4) continue;
    const dir = unescapeMountField(fields[1]!);
    if (!isAncestorDir(dir, path)) continue;
    if (best && dir.length <= best.dir.length) continue;
    best = {
      dir,
      private: isPrivateFuse(fields[2]!, fields[3]!.split(',')),
    };
  }
  return best?.private ?? false;
}
