# elementType 6 — 系统表情

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 6`）。

QQ 自带表情，包含普通小黄脸、超级表情、互动表情。
（**商城表情**是另一个类型，见 [mface](./mface.md)。）

---

## 一、subType

| 值 | 名称 | 说明 |
| -- | ---- | ---- |
| 1 | QQ_BUILTIN_OLD | 旧版内置表情 |
| 2 | QQ_BUILTIN_NEW | 新版内置表情 |
| 3 | SUPER_EMOJI | 超级表情（会带 `476xx` 的超级表情字段） |
| 4 | UNKNOWN_4 | 未知 |
| 5 | INTERACTIVE | 互动表情 |

## 二、必有字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 47601 | `faceId` | uint32 | 表情 id（例：骰子 `FaceIndex.DICE = 358`） |
| 47602 | `faceText` | string | 表情文字描述 |

## 三、超级表情

仅 subType=3 时出现。

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 47603 | `superEmojiCategory` | string | 超级表情分类 |
| 47604 | `AniStickerId` | string | 动画贴纸 ID |
| 47605 | `superEmojiFlag1` | uint32 | 标志 1 |
| 47606 | `superEmojiFlag2` | uint32 | 标志 2 |
| 47607 | `diceValue` | string | **命名为骰子点数**，实际上是随机表情的随机值<br />包括骰子，包剪锤，篮球等等 |
| 47609 | `superEmojiFlag3` | uint32 | 标志 3 |
| 47610 | `superEmojiFlag4` | uint32 | 标志 4 |

## 四、其它可选字段

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 45004 | `faceExtDesc` | string | 扩展描述（注意这个 tag 落在通用段而非 476xx 段） |
| 47608 | `faceFlag47608` | bytes | 未知的长度分隔字段 |
| 47622 | `canChain` | bool | 该表情是否支持连锁反应 |

## 五、`47611..47621` —— 几乎每个表情都会捎带的一块

不论 subType 如何，这一块基本都会出现在 FACE element 上。其中只有
`47612` / `47615` / `47616` / `47621` 真正携带内容，其余是标志位，绝大多数行里为 0。

| tag | 字段名 | 类型 | 含义 / 观测 |
| --- | ------ | ---- | ----------- |
| 47611 | `faceFlag47611` | uint32 | 多数为 0/1，偶见 2..6 或 126 |
| 47612 | `interactiveFaceName` | string | **互动表情名称**，如「模了个块」。通常为空 |
| 47613 | `faceFlag47613` | uint32 | 恒为 0（有一行为 1） |
| 47614 | `faceFlag47614` | uint32 | 恒为 0（有三行为 2003） |
| 47615 | `interactiveFaceName2` | string | 互动表情名称副本 —— 所有观测行都与 47612 相同 |
| 47616 | `interactiveFaceVersion` | string | **互动表情版本号**，如 `7.2.0`。通常为空 |
| 47617 | `faceFlag47617` | uint32 | 取值 0/1/2/3 |
| 47618 | `faceFlag47618` | uint32 | 恒为 0 |
| 47619 | `faceFlag47619` | uint32 | 恒为 0 |
| 47620 | `faceFlag47620` | uint32 | 恒为 0 |
| 47621 | `faceFallbackText` | string | **旧版客户端降级文案**，如「[戳一戳]请使用最新版手机QQ体验新功能。」。所有客户端都能渲染的表情上为空 |

---

[← 返回消息段索引](../index.md#消息段element索引)
