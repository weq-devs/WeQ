# elementType 26 — 空间动态提示

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 26`）。

QQ 空间动态（说说 / 动态）的分享卡，QQ 内部名 TOFU。tag 段为 `481xx`。

以下结论来自对一份真机安卓备份库（`nt_msg.db`，c2c + group 共约 268 万行）的全表扫描，
共命中 133 条 QQ_DYNAMIC 元素，覆盖 `dynamicType` ∈ {1,2,6,11,13,15,16,17,18,22} 共 10 种取值。
样本量不大，未覆盖到的 `dynamicType`/字段取值仍可能存在，遇到未知类型时渲染要有兜底。

---

## 一、字段

除 `dynamicTags` 外，下列字段在 QQ_DYNAMIC element 上都是必有的。

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 48172 | `dynamicType` | uint32 | ✅ | 动态类型，真实枚举见下 |
| 48173 | `dynamicId` | string | ✅ | 动态 id |
| 48174 | `dynamicFlag48174` | uint32 | ✅ | 卡片子样式 id，见下 |
| 48175 | `dynamicDesc` | message | ✅ | 主描述块，见下 |
| 48176 | `dynamicDesc2` | message | ✅ | 次描述块（结构同 48175） |
| 48180 | `dynamicCoverUrl` | string | ✅ | 封面图 URL |
| 48181 | `dynamicZoneLogoUrl` | string | ✅ | QQ 空间 logo URL |
| 48182 | `dynamicPublisherUin` | **repeated** uint32 | ✅ | 动态相关方 QQ 号，见下「48182 可重复」 |
| 48183 | `dynamicMeta` | string | ✅ | 动态 meta 数据，三种形态见下 |
| 48188 | `dynamicPublisherUid` | string | 仅老客户端 | 动态发布者 uid（配合 48182 走 profile 解析拿昵称/头像） |
| 48189 | `dynamicTags` | repeated message | | 标签列表，见下 |

### 48182 可重复 —— 之前的建模是个真 bug

之前把 `dynamicPublisherUin` 当单值 `uint32` 建模。实测在密友绑定（`dynamicType=22`）、
节日提醒（`dynamicType=15`）这类"双方"场景里，48182 在同一个 element 里**出现两次**（各自的
uin），例如：

```
48182 = 3253910961   # 对方
48182 = 1707889225   # 自己
```

单值建模在 wire 层面会被"后一次出现覆盖前一次"，也就是静默丢掉前一个 uin——这不是罕见 edge
case，是这两类卡片的正常形态。现已改为 `repeat: true`，解出来是 `number[]`。单人场景（如
`dynamicType=2/6/16/17/18`）该数组长度为 1。

### 48174 与 48172 的关系

`dynamicFlag48174`（原文档写"未知整数"）跟 `dynamicType` 近似一一对应（同一 dynamicType 观测到
的 48174 取值稳定），推测是"卡片子样式/模板 id"，用来选客户端具体走哪套排版。语义仍未完全确认，
先按未知整数保留，不建议改名成更具体的语义名。

### dynamicType 真实枚举（实测，非猜测）

| 值 | 对应场景 | 样本 mainDesc（48175.mainDesc） |
| -- | -------- | --------------------------------- |
| 1 | 好友更新了个性签名 | "更新了个签" |
| 2 | 好友发布了说说/动态 | "发布了动态" |
| 6 | 好友生日礼物提醒 | "好友生日·MM月DD日" |
| 11 | 互动认证/认识多久提醒 | （空，正文在 base64 编码的 48183 里） |
| 13 | 匿名提问被回答 | "回答了匿名提问" |
| 15 | 节日/纪念日提醒 | "提醒" |
| 16 | （未采到 mainDesc，推测点赞类） | "" |
| 17 | 好友更换了装扮（气泡/头像动作/来电铃声等） | "更换了个性气泡" / "更换了头像双击动作" / "更换了个性来电" |
| 18 | （未采到 mainDesc，推测戳一戳/贴贴类） | "" |
| 22 | 密友绑定提醒 | "密友绑定提醒·点击绑定" |

## 二、描述块（48175 / 48176）

两者结构相同：

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48178 | `mainDesc` | string | 主描述 |
| 48179 | `subDesc` | string | 次描述——**实际是十六进制颜色**（如 `#878B99`），QQ 原生客户端用它给
`mainDesc` 上色，不是真的"副标题文字"。之前渲染完全没用这个字段，文字都是无色的。 |

`dynamicDesc2` 同构：`mainDesc` 是正文内容（如"发布了动态"场景下说说的文字摘要），`subDesc` 同样
是颜色。实测样本中，`dynamicDesc.mainDesc` 为空时，`dynamicDesc2` 也从未补上过（61/61 次都是双
空），所以"用 desc2 兜底 desc"这条 fallback 路径在实测里从未真正触发，但保留无害，不必删。

## 三、标签项（48189，repeated）

| tag | 字段名 | 类型 | 含义 |
| --- | ------ | ---- | ---- |
| 48191 | `flag48191` | bool | 是否为"推荐/高亮"标签——实测同一条消息的多个 tag 里最多一个为
`true`（如生日祝福语里的"想要同款"、"比心"），客户端应该是把它加粗/上色跟其余 tag 区分开。 |
| 48192 | `tagId` | uint32 | 标签 id（枚举表在服务端，客户端不需要反查，直接显示 `tagContent`
即可） |
| 48193 | `tagContent` | string | 标签内容（如"生日快乐"、"贴贴"、"真好看"） |

## 四、dynamicMeta（48183）的三种形态

字段类型是 string，但内容随 dynamicType 变化，实测出现过三种形态：

1. **空字符串**——多数"轻量"提醒类（16/18 等）。
2. **JSON 对象**——常见 key：
   - `jumpUrl` / `jump_h5`：直接可用的 https 链接（如生日礼物商城、密友绑定 H5）。
   - `jump_schema`：`mqqapi://qzoneschema/?schema=<base64>`，`base64` 解码后是
     `mqzone://arouse/detail?appid=...&uin=...&cellid=...`，即"跳转到空间详情页"的内部协议，
     渲染端只能识别但打不开（非 http(s)），跟 ark 卡片对内部协议的处理策略一致（忽略点击）。
   - `desc1` / `desc1_color` / `icon` / `icon_bg_color`：装扮变更卡（dynamicType=17）用，目前样本里
     `desc1` 恒为空串，`icon`/`icon_bg_color` 有值但未使用。
3. **base64 编码的嵌套 protobuf**——仅在 `dynamicType=11`（互动认证/认识多久）见到。整段
   48183 的 bytes 本身就是合法 UTF-8（因为内容是 base64 字符集），base64 解码后是另一层 protobuf，
   schema-free 解出来能看到"认识 N 天"、"共同好友"、对方昵称等中文可读片段，以及一个头像 CDN
   URL。这层结构目前**没有专门建模**（工作量大、字段含义需要更多样本交叉验证），新版渲染采用
   schema-free 通用解码 + 提取所有 UTF-8 叶子字符串的方式做"尽力而为"展示，不保证完整。

## 五、观测到但未建模的字段

以下 tag 在部分（主要是 2024 年前后的老客户端）样本里出现，但没有编码价值或语义未知，故意不建模，
仅记录在此供以后排查：

- `45003`、`48171`：值恒等于外层 `elementType`（即 26），是纯冗余镜像字段，不携带额外信息。
- `48184`、`48185`、`48186`：bool，实测样本里恒为 `false`，语义未知。

以上字段在新版（2025+）客户端产生的消息里大多不再出现，`48188`（`dynamicPublisherUid`）同理只在
老样本里见到——新客户端可能把 uid 解析责任转移到了别处，渲染端应把它当可选字段处理。

---

[← 返回消息段索引](../index.md#消息段element索引)
