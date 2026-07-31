# elementType 10 — ARK 卡片

对应 WeQ 解析实现：`packages/codec/src/proto/msg/element.ts`（`elementType = 10`）。

ARK 是 QQ 的结构化卡片消息：分享链接、小程序、群公告卡、游戏中心广告等等，
渲染样式由服务端下发的模板决定。

wire 层极其简单——**只有三个字段**，真正的内容全在一段 JSON 字符串里。

---

## 一、字段

| tag | 字段名 | 类型 | 必有 | 含义 |
| --- | ------ | ---- | ---- | ---- |
| 47901 | `arkData` | string | ✅ | **卡片 JSON 负载**（UTF-8 字符串装的 JSON 文档） |
| 47902 | `arkSignature` | string | | 64 字符 base64 卡片签名，与 JSON 里的 `config.token` 配对 |
| 47904 | `arkCardId` | string | | 卡片实例 UUID，如 `33cad47c-09f0-42a6-ab42-6329c0898765` |

## 二、`arkData` 的 JSON 结构

顶层形状固定（`ArkPayload`），但 `meta` 的内部结构**随 `view` 而变**——
这是解析 ARK 的关键：先看 `view`，再决定怎么读 `meta`。

```ts
interface ArkPayload {
  app: string;          // 应用标识，如 "com.tencent.gamecenter.mall"
  desc: string;         // 描述，如 "QQ手游消息"
  meta: Record<string, Record<string, unknown>>;  // 形状取决于 view
  prompt: string;       // 会话列表外显文案
  sourceName?: string;
  ver?: string;
  view: string;         // 模板名 —— 决定 meta 的形状
  config?: {
    ctime: number;      // unix 秒
    token: string;      // 卡片签名 token
  };
}
```

典型读法：

```ts
const payload = JSON.parse(el.arkData) as ArkPayload;
if (payload.view === 'pubAdArkView') {
  const t = payload.meta.template3 as Record<string, unknown>;
  // ...
}
```

## 三、样例：`view: "pubAdArkView"`

代码里保留了一份实际抓取的完整样例
（`packages/codec/src/element/ark.ts` 的 `SAMPLE_GAME_CENTER_AD`），
是推送进聊天的 QQ 游戏中心广告，`meta` 下挂 `template3`：

| 字段 | 说明 |
| ---- | ---- |
| `arkType` | 具体子模板，如 `pubSinglePicArk` |
| `title` / `contentText` | 标题 / 正文 |
| `coverUrl` | 封面图 |
| `url` | 点击跳转地址 |
| `appid` / `adId` / `actId` / `feedId` | 各类业务 id |
| `time` | 时间戳（字符串形式） |
| `__preloadFields` | 客户端预加载提示，值为需要预取的字段名 |

> 想支持新的卡片样式，就在 `ark.ts` 里再加一个样例常量：把逆向出来的 `view`
> 与对应 `meta` 形状固化下来，避免每次都重新猜。

---

## 四、渲染：`app` 才是真正的判别式

上面说 `view` 决定 `meta` 的形状，那是从 JSON 文档自身看。但**渲染**这一侧，
WeQ 的判别式是 `app`（如 `com.tencent.structmsg`）而不是 `view`——
因为 QQ 官方的 ark 资源包本身就是按 app 组织的。

渲染链路（`apps/desktop/src/renderer/src/components/ark/`）：

| 文件 | 职责 |
| ---- | ---- |
| `ark-cards.generated.json` | **机械提取**的绑定表：`app → metaKey → { jump, slots, bindings }` |
| `arkCards.ts` | 在其上叠加**人工策展**（布局归类 + 标准字段兜底），产出渲染器直接消费的 `ArkValues` |
| `QqArk.tsx` | 按布局类型渲染 |

### 数据从哪来

`ark-cards.generated.json` 由 `scripts/extract-ark-cards.mjs` 从 QQ 官方 ark 资源包
（`resources/arks_resource/<app>/<时间戳>/index.js`）机械提取：

- 每个 `index.js` 用 `_setViewTemplate('<id>', \`<XML>\`)` 注册布局模板；
- 用 Lua 的 `ViewModel:OnSetMetadata(value)` 定义 `data["字段"] → self.<节点>` 的绑定。

脚本只抽取静态渲染需要的「排版 + 字段绑定」，运行时 Lua 逻辑、网络请求、动效一律忽略。

> ⚠️ 原始资源包约 25MB，提取完成后已从仓库删除，只保留脚本与生成的 JSON。
> 需要重新生成时得先把 ark 包放回 `resources/arks_resource/` 再跑
> `node scripts/extract-ark-cards.mjs`。

### 生成 JSON 的结构

```jsonc
{
  "com.tencent.music.lua": {
    "defaultMetaKey": "music",          // payload 没命中已知变体时的兜底
    "variants": {
      "music": {
        "jump": "jumpUrl",              // 点击跳转取自 meta 的哪个字段
        "slots": {                      // 自动归一化的「语义槽 → meta 字段」
          "title": "title",
          "desc": "desc",
          "thumb": "preview",
          "sourceIcon": "tagIcon"
        },
        "bindings": {                   // 原始的「模板节点 id → meta 字段」，未归一化
          "titleView": "title",
          "descView": "desc",
          "background": "preview",
          "tagIcon": "tagIcon"
        }
      }
    }
  }
}
```

`slots` 与 `bindings` 的区别：`bindings` 是从 Lua 里原样抠出来的节点绑定，
`slots` 是在其之上自动归一化出的语义槽位（长尾 app 的兜底）；
常见 app 的权威槽位在 `arkCards.ts` 里手写覆盖。

### 已收录的 16 个 app

`defaultMetaKey` 是 payload 的 `meta` 里没有任何已知变体时的兜底选择。

| app | 默认 metaKey | 变体 |
| --- | ------------ | ---- |
| `com.tencent.contact.lua` | contact | contact |
| `com.tencent.miniapp.lua` | miniapp | miniapp |
| `com.tencent.mobileqq.cardshare` | contact | contact |
| `com.tencent.music.lua` | music | music |
| `com.tencent.od` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.qidian.general` | pic | pic, transfercontact |
| `com.tencent.qqgxh.general` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.qun.invite` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.structmsg` | news | news, music, video, contact, messages |
| `com.tencent.tdoc.qqpush` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.template.qqfavorite.share` | news | news |
| `com.tencent.tianxuan.share` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.together` | invite | invite |
| `com.tencent.troopsharecard` | pic | pic, news, music, video, contact, messages, miniapp |
| `com.tencent.tuwen.lua` | news | news |
| `com.tencent.weishi.public.share` | pic | pic, news, music, video, contact, messages, miniapp |

### 布局归类

布局**不进** JSON —— 刻意保持「机械提取的数据」与「人工策展」分离。
`arkCards.ts` 里有两张表，按下面的优先级决定用哪种布局：

1. **`APP_LAYOUT`** — 单一用途的 app 直接钉死布局（覆盖 metaKey 推断）：

   | app | 布局 |
   | --- | ---- |
   | `com.tencent.miniapp.lua` | appBlock |
   | `com.tencent.contact.lua` | contact |
   | `com.tencent.mobileqq.cardshare` | contact |
   | `com.tencent.music.lua` | news |
   | `com.tencent.tuwen.lua` | news |
   | `com.tencent.together` | mediaBlock |

2. **`METAKEY_LAYOUT`** — 多模板分享类 app（structmsg / troopsharecard / …）按变体名推断：

   | metaKey | 布局 |
   | ------- | ---- |
   | news / music / video / messages / pic | news |
   | contact / transfercontact | contact |
   | miniapp | appBlock |
   | invite | mediaBlock |

3. 两张表都没命中 → `generic`（仍然带槽位值，好过纯猜）。

### 语义槽位

归一化后交给渲染器的字段（`ArkValues`）：

| 槽位 | 含义 |
| ---- | ---- |
| `title` / `desc` / `summary` | 标题 / 描述 / 摘要 |
| `thumb` | 小方缩略图 |
| `cover` | 通栏大图 |
| `name` / `avatar` | 名称 / 头像（联系人类卡片） |
| `source` / `sourceIcon` | 顶部主来源标签文字 / 图标 |
| `footerSource` / `footerIcon` | 底部来源标签（部分卡片顶底各有一个来源，如小程序顶=来源、底=「QQ小程序」） |
| `button` | 按钮文案 |
| `jump` | 点击跳转地址 |

槽位没覆盖到的，再用 QQ 通用字段名兜底（各卡字段命名高度一致），
按顺序尝试，例如 `desc` 依次试 `desc` → `digest` → `contactInfo` → `contact` → `address`，
`jump` 依次试 `jumpUrl` → `qqdocurl` → `url`。

---

[← 返回消息段索引](../index.md#消息段element索引)
