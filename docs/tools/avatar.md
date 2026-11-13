# 头像缓存路径预测

QQ 把看过的每个头像都缓存在 `nt_data/avatar/<scope>/` 下，文件名是 32 位 hex，不是 QQ 号。
这个 hex 由 uid 算出来，知道公式就能**直接从 uid 跳到文件**，不用扫目录。

<AvatarPathCalculator />

## 公式

```text
hash = md5( md5( md5(uid) + uid ) + uid )
```

三次 MD5，每次拼的是上一次的 **hex 字符串**（不是字节）。实现见
`packages/service/src/account/avatar_resource.ts` 的 `avatarHashForUid()`。

## 三个作用域

| scope | 放什么 | uid 是什么 |
| --- | --- | --- |
| `user` | 好友、陌生人 | `u_` 开头的字符串 |
| `group` | 群头像 | 群的数字群号（uin 与 uid 相等） |
| `cover` | 资料卡封面 | 与好友同形的 uid |

## 目录形状

```text
nt_data/avatar/user/<hash前两位>/b_<hash>    ← 640×640 大图（JPEG，无扩展名）
nt_data/avatar/user/<hash前两位>/s_<hash>    ← 缩略图
nt_data/avatar/group/temp/<hash>             ← 偶尔出现的暂存文件
```

Windows 按 hash 前两位分桶；**Linux 是扁平布局**，`b_` / `s_` 文件直接躺在
`avatar/<scope>/` 下。两种都要能查，工具里已经分别给出。

## 大图和缩略图可能不是同一张

换头像时 QQ 会立刻重下缩略图（列表里到处都是），大图只在真正需要时才拉。于是会出现
「`s_` 是现在的头像，`b_` 还是几个月前的」。

实测一台真实缓存（1060 个同时存在 `b_`/`s_` 的条目）：所有「`s_` 更新」的正向差值都
**超过 1 天**，抽样 38/40 对是不同的图；反过来「`b_` 更新」时抽样 40 对全部相同。
所以判据是 **mtime 差超过 1 天就认定换过头像**，WeQ 取两者中更新的那个。

::: tip

微信 / QQ 的头像 CDN 地址里那个 `ek=` 参数**不是**这个 hash，别混用。

:::

## 相关

- [数据库一览](/database/) —— `profile_info` 里的头像相关字段
- [QQ 数据目录速查](paths.md) —— 账号目录与 `nt_data` 的完整位置
