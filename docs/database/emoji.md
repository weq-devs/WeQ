# emoji.db — 表情

QQ 表情的本地库。WeQ 解析两张表：**内置系统表情元数据**和**已添加的商城表情包清单**。
单条消息里实际用到的表情走消息表的 face/mface 消息段（见
[face](./nt_msg/elements/face.md) / [mface](./nt_msg/elements/mface.md)），那张表存的是引用，这里是定义。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/emoji/base_sys_emoji.ts` | `base_sys_emoji_table` → `SysEmoji` |
| `packages/db/src/emoji/market_emoticon_package.ts` | `market_emoticon_package_table` → `MarketEmoticonPackage` |

---

## 一、`base_sys_emoji_table` — 内置表情元数据

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 81211 | `id` | INTEGER | 表情 ID（faceElement 的 faceId 回指这里） | 已验证 |
| 81212 | `desc` | TEXT | 外显文字（`[微笑]`；部分行直接是 emoji 字符） | 已验证 |
| 81214 | `unicodeId` | INTEGER | Unicode 字符表情的 face_id（如 😊 = 128522）；0/空 = 非此类 | 已验证 |
| 81221 | `special` | INTEGER | `0` 正常 / `1` 特殊类表情 | 观测一致 |
| 81226 | `emojiType` | INTEGER | `1` 系统表情 / `2` emoji 表情 / `3` 动态可变表情（掷骰子等） | 观测一致 |
| 81229 | `staticUrl` | TEXT | 静态图片下载地址 | 已验证 |
| 81230 | `apngUrl` | TEXT | APNG 动图下载地址（emoji 类无此链接） | 观测一致 |

`81218` 是 81229/81230 下载链接的 protobuf 包，无解析价值，跳过。

### Unicode 字符表情（关键点）

`81214` 有值且非 0 的行是「Unicode 字符表情」（😊 这类）。它们会以 faceElement /
贴表情的形式被发送，**但没有本地图片资源** —— 前端必须按 Unicode 字符直接渲染：

```sql
SELECT … FROM base_sys_emoji_table WHERE "81214" IS NOT NULL AND "81214" != 0;
```

WeQ 的读法（整表）：

```sql
SELECT "81211","81212","81214","81221","81226","81229","81230"
FROM base_sys_emoji_table;
```

## 二、`market_emoticon_package_table` — 商城表情包清单

每行 = 用户添加到本地的**一个表情包**（不是单个表情）。纯 SQLite，无 protobuf。

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 80943 | `packId` | TEXT | 表情包 id，**主键**，等同 mface element 的 `emojiPackId` | 已验证 |
| 80947 | `name` | TEXT | 表情包名称（如 `3D萌弹PUPU鹅`） | 已验证 |
| 80948 | `summary` | TEXT | 描述文案 | 观测一致 |
| 80963 | `addTime` | INTEGER | 添加时间（unix 秒），列表排序键 | 已验证 |
| 80970 | `sizeInfoJson` | TEXT | 尺寸列表 JSON，如 `[{"Height":300,"Width":300}]` | 观测一致 |

与 mface 消息段的关联：消息里的 mface 带着表情包 id + 表情 id，
清单负责把 id 翻译成包名/描述；单个表情的图片资源不在库里，按 mface 的 CDN 规则取。

```sql
SELECT "80943","80947","80948","80963","80970"
FROM market_emoticon_package_table
ORDER BY "80963" DESC;   -- 最近添加在前
```

## 三、未解析部分

- 单个商城表情的明细表（包内表情列表）；
- 表情商店/推荐相关缓存；
- 其它未触碰的表。

---

[← 返回数据库分析](./index.md)
