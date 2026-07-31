# elementType 26 — 空间动态提示

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 26`）。

QQ 空间动态（说说 / 动态）的分享卡，QQ 内部名 TOFU。tag 段为 `481xx`。

---

## 一、字段

除 `dynamicTags` 外，下列字段在 QQ_DYNAMIC element 上都是必有的。

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48172 | `dynamicType` | uint32 | ✅ | 动态类型 |
| 48173 | `dynamicId` | string | ✅ | 动态 id |
| 48174 | `dynamicFlag48174` | uint32 | ✅ | 未知整数 |
| 48175 | `dynamicDesc` | message | ✅ | 主描述块，见下 |
| 48176 | `dynamicDesc2` | message | ✅ | 次描述块（结构同 48175） |
| 48180 | `dynamicCoverUrl` | string | ✅ | 封面图 URL |
| 48181 | `dynamicZoneLogoUrl` | string | ✅ | QQ 空间 logo URL |
| 48182 | `dynamicPublisherUin` | uint32 | ✅ | 动态发布者 QQ 号 |
| 48183 | `dynamicMeta` | string | ✅ | 动态 meta 数据 |
| 48189 | `dynamicTags` | repeated message | | 标签列表，见下 |

## 二、描述块（48175 / 48176）

两者结构相同：

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48178 | `mainDesc` | string | 主描述 |
| 48179 | `subDesc` | string | 次描述 |

## 三、标签项（48189，repeated）

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48191 | `flag48191` | bool | 未知标志 |
| 48192 | `tagId` | uint32 | 标签 id |
| 48193 | `tagContent` | string | 标签内容 |

---

[← 返回消息段索引](../index.md#消息段element索引)
