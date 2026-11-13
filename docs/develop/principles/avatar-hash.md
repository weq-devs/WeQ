# 头像 Hash 定位公式

QQ 把看过的每个头像都缓存在本地，文件名不是 uin，而是一串 32 位 hex。
这个 hex 由 uid 算出来，知道公式就能**直接从 uid 跳到缓存文件**，不需要扫目录。

## 一、公式

```text
hash = md5( md5( md5(uid) + uid ) + uid )
```

三次 md5，每次把上一次的 **hex 字符串**（不是字节）与 uid 拼接。
等价写法：

```js
const md5 = (s) => createHash('md5').update(s).digest('hex');
const avatarHashForUid = (uid) => md5(md5(md5(uid) + uid) + uid);
```

实现见 `packages/service/src/account/avatar_resource.ts` 的 `avatarHashForUid()`。

## 二、文件落在哪

```text
<QQ 数据根>/nt_data/avatar/<scope>/<hash 前两位>/b_<hash>
<QQ 数据根>/nt_data/avatar/<scope>/<hash 前两位>/s_<hash>
```

- `<scope>` 有 `user`（好友 / 陌生人）、`group`（群）、`cover`（资料卡封面）三类
- 文件按 hash 的前两个 hex 字符分桶，避免单目录塞十万个文件
- `b_` = big，640×640 大图；`s_` = small，缩略图
- 文件**没有扩展名**，内容是 JPEG

`group` 作用域的 uid 就是群的数字 uin（两者相等），`user` 作用域则是 `u_xxx` 形态。

## 三、大图和缩略图可能不是同一张

这是最容易踩的坑：`b_` 和 `s_` 对同一个 hash 并不保证是同一张图。

换头像时 QQ 会立刻重下缩略图（列表里到处都是），但大图只在真正需要时才拉。
于是会出现「`s_` 是现在的头像，`b_` 还是几个月前的」。

实测一台真实缓存（1060 个同时存在 `b_`/`s_` 的条目）：

| 情况 | 样本数 | 两张图不同 |
| --- | --- | --- |
| `s_` 比 `b_` 新 | 433 个正向差值，全部 > 1 天 | 抽样 40 对里 38 对不同 |
| `b_` 比 `s_` 新 | — | 抽样 40 对**全部相同** |

所以判据很干净：**mtime 差超过 1 天，就认定换过头像**。
这个阈值避开同一张图两次下载的秒级抖动。

`resolveByUidFile` 因此取两者中**更新的那个**，并回报取到的是哪一档 ——
调用方拿到「只有缩略图是新的」这一信息时，应该优先用 CDN 地址
（更新、分辨率也更高）。

## 四、这个公式**不是**什么

`profile_info` 库里有个头像字段，容易被误当成同一个 hash。已经排除：

- **不是**本地头像文件名 hash `md5(md5(md5(uid)+uid)+uid)`（各 60 样本，0 命中）
- **不出现在** CDN URL 的 `ek=` 参数里

见 [profile_info 字段分析](/database/profile_info/profile-info-v6)。

## 五、相关

- `packages/service/src/account/avatar_resource.ts` — 枚举、解析与变体合并
- `weq-media://avatar?scope=user&hash=<hash>&v=big|small` — 渲染进程取字节的协议
- [数据库一览](/database/) — `profile_info` 里的头像相关字段

---

[← 返回原理总览](index.md)
