# misc.db — 杂项（好友在线状态）

`misc.db` 是账号目录下的杂项库，WeQ 目前只解析其中一张表：
**`online_status_kv_table`** —— 好友在线状态的本地缓存。

对应 WeQ 解析实现：

| 文件 | 职责 |
| ---- | ---- |
| `packages/db/src/profile/misc.ts` | `MiscDb.getUserOnlineStatus` |
| `packages/codec/src/proto/profile/48902.ts` | `48902` 列的 protobuf 定义 |
| `packages/service/src/account/online_status.ts` | `OnlineStatusService`：枚举翻译 + 展示文案 |

> 别混淆：这份是**库里缓存的**好友在线状态。WeQ 首页的「本机 QQ 在线实例数」
> 是探测运行中进程得出的（`probeOnline`），与这张表无关。

---

## 一、`online_status_kv_table`

典型的 KV 表，**一行 = 一个好友**：

| 列 | 字段名 | 类型 | 含义 | 置信度 |
| -- | ------ | ---- | ---- | ------ |
| 48901 | — | TEXT | 好友 uid，**查询键** | 已验证 |
| 48902 | `status` | BLOB | protobuf 在线状态体，见下 | 已验证 |

注意 `48901/48902` 这对列号在 `nt_uid_mapping_table` 里是 sortNo/uid 的身份目录，
在这里是「uid → 状态 blob」的 KV —— 同号不同义，别跨表联想。

WeQ 的读法（点对点查询，不做全表扫描）：

```sql
SELECT "48902" FROM online_status_kv_table WHERE "48901" = ?;
```

## 二、`48902` — protobuf 结构

三层嵌套，tag 编号大部分沿用 QQ 全局的列号语义（1002 = uin 等）：

```text
48902 (BLOB)
└── 48902  OnlineStatusInnerWire（外壳）
    └── 20320  OnlineStatusDetailWire（detail）
        ├── 1002   uin         对端 QQ 号
        ├── 20322  uid         对端 uid
        ├── 20323  type        主状态，见下表
        ├── 20324  subType     子状态（趣味状态 id）
        ├── 20355  statusName  自定义状态文本
        └── 20337  extendedPayload  扩展状态负载，按 subType 解释
            └── subType = 2000：OnlineStatusCustomWire
                ├── 1  faceId    uint32，表情编号
                ├── 2  text      string，自定义状态文字
                └── 3  faceType  uint32，表情类型
```

## 三、type / subType 枚举

`type`（`OnlineType`，`online_status.ts`）：

| 值 | 名称 |
| -- | ---- |
| 0 | 离线 |
| 10 | 在线 |
| 30 | 离开 |
| 40 | 隐身 |
| 50 | 忙碌 |
| 60 | Q我吧 |
| 70 | 勿扰 |

`subType` 是「趣味状态」id（听歌中 / 搬砖中 / 追剧中……，约 35 种，
完整映射表见 `SUB_TYPE_NAMES`）。关键规则：**只在 `type = 10`（在线）时翻译 subType**，
其它主状态下 subType 没有意义。

## 四、展示逻辑

`OnlineStatusService.getOnlineStatus` 的合成规则：

1. `displayStatus` 优先取 `statusName`（用户自定义的状态文本）；
2. 没有 statusName 时用 `type` 的中文名；
3. `type = 10` 且 subType 有映射时，显示成 `在线 - 听歌中` 这样的组合；
4. 行不在表里 / blob 解不出 detail，返回 `null` —— 离线好友本来就没有行。

5. `type = 10`、`subType = 2000` 且自定义文字非空时，优先显示该文字。

2026-10-20 只读核对本机实际缓存后发现，旧版将 `20337.1` 错定为天气字符串，
自定义状态的数值表情编号使其抛出 `premature EOF`，连带阻断基础状态读取。
现保留扩展负载原字节，仅在已核实的自定义状态类型下解码；其它类型（包括天气）
没有核实结构，不套用自定义状态 schema。回归使用合成账号和文字，不保存真实样本。

---

[← 返回数据库分析](./index.md)
