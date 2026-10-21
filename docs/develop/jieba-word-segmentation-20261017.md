# 词云 / 常用语的中文分词（接入 QQ 自带结巴词典），2026-10-17

## 背景：原来漏了哪些词

`packages/service/src/account/text_segment.ts` 的 `segmentWords()` 是「词云 / 常用语」唯一的分词
入口，原先只走 `Intl.Segmenter`（Electron 自带全量 ICU 词典）。ICU 的通用词典对中文**技术词**
很弱，实测一批真实群消息（800 条）后，下面这些词被切碎或整个丢掉，进而从词云里消失：

| 原文词 | ICU 切法 | 结果 |
| --- | --- | --- |
| 密钥 | 密 / 钥 | 全丢（单字被过滤） |
| 重启 | 重 / 启 | 全丢 |
| 二维码 | 二 / 维 / 码 | 全丢 |
| 链接 | 链 / 接 | 全丢 |
| 安装包 | 安装 + 包 | 只剩「安装」 |
| 数据库 | 数据 + 库 | 只剩「数据」 |
| 浏览器 | 浏览 + 器 | 只剩「浏览」 |

而 QQ NT 自带一份结巴（jieba）词典，上面这些词**全都收录**，`区块链` 这种新词还躺在用户词典里。
所以本轮把这份词典接进来，作为分词的**首选**；同一份词典还随仓库 `resources/jieba/` 分发，
QQ 那边读不到时用它兜底，不再依赖 `Intl.Segmenter`。

## QQ 词典在哪、怎么定位

词典在 QQ 数据根的**共享 `global/` 树**里，**不在账号目录**（账号目录 `nt_qq_<hash>/nt_data`
下没有 `search`）：

```
linux / macOS:  <QQ 数据根>/global/nt_data/search/resource_jieba/
win32:          <Tencent Files>/nt_qq/global/nt_data/search/resource_jieba/
```

目录里三份文件（QQ 还会放一个 `resource_jieba.zip`，我们直接读解压后的明文）：

- `jieba_dict.utf8`：主词典，每行 `词 词频 [词性]`，约 34.9 万条；
- `user_dict.utf8`：用户词典，无词频的行视为**强制成词**（QQ 自己往里塞新词，如 `区块链 10 nz`）；
- `hmm_model.utf8`：HMM 模型（B/E/M/S 四态的起始 / 转移 / 发射 log 概率），给词典外的生词猜边界。

解析入口是 `Platform.jiebaDictDir()`（三端各一份实现，都在 `global` 下拼 `nt_data/search/resource_jieba`）。
**刻意只认主位置、不再回退 `nt_qq/global`**（`login.db` 保留那个遗产回退）：这是边缘功能，老布局
直接走随包词典即可。`resource_roots.ts` 的 `withResourceRoots` 不拦它 —— 词典账号无关、不含隐私，
静态账号继续用本机那份只会更好。

## 随包词典

QQ 的那份词典未必存在（新装 QQ 没搜过、用户选的数据目录不含 `global/`、静态账号等）。因此
仓库里随包一份同格式的词典：

```
resources/jieba/
  jieba_dict.utf8
  user_dict.utf8
  hmm_model.utf8
```

它是 QQ 词典的拷贝，`electron-builder.yml` 的 `extraResources` 会整棵 `resources/` 带进安装包；
web 的 `build-server.mjs` 也整棵复制。运行时按下面的顺序加载，第一份可用的胜出：

1. `Platform.jiebaDictDir()`（QQ 自带，可能随版本更新）；
2. `resolveResource('jieba')`（随包兜底）。

两份都读不到时 `segmentWords()` 返回空数组，调用方照常渲染空词云 —— **不再回落到 ICU / 正则**，
以免不同机器上分词口径漂移。

## 分词器实现

纯计算的分词引擎放在 `@weq/agentlab/src/segment.ts`（叶子包，本来就有 `http.ts` / `persona.ts`
这类文本工具），不碰文件 IO：

1. **词典 + 动态规划**：对每个中文连续段求「词频对数之和最大」的切分。比朴素最大匹配准，
   歧义切分（`北京大学` vs `北京/大学`）靠词频取舍。
2. **HMM 兜底**：DP 切出来的「未知单字」攒成一段，交给 Viterbi 猜 B/E/M/S 边界 —— 没有它，
   生词（`跑路`、`好累`）会退化成单字被过滤掉。
3. **英文 / 数字**整块保留（英文小写化），与结巴一致，**只切分、不过滤**：虚词该不该丢是调用方的事。

`@weq/service` 的 `text_segment.ts` 继续过滤单字 / 纯数字 / 残留虚词，并把「切词」这一步换成
词典版本；词典加载由 `warmJiebaDict(dirs)` 惰性完成（进程级单例，账号无关只加载一次），
按顺序尝试目录，全部失败时静默跳过。

### 词性白名单

词云 / 常用语 / 口头禅不再靠「个人语料黑名单」压高频词，而是用 QQ 词典里的词性做**白名单**：
只保留 `n` / `v` / `vn` / `ns` / `nr` / `nz` / `nrt` / `nrfg` / `nt` / `i` / `j` / `z` / `o` /
`e` / `unknown`（`unknown` 是词典外生词，保住网络新词）。代词、副词、连词、介词、时间词、
量词、语气词等语法词不进词云。白名单定义在 `@weq/agentlab` 的 `CHAT_POS_WHITELIST`，
`cutForChat()` 按它过滤；`segmentWords` 与 `tokenizeText` 都走同一条切词路径。

停用词与 token 归一化仍集中在 `stopwords.ts` 的 `normalizeChatToken()`，负责兜底过滤单字、
纯数字、纯符号、英文功能词和残留虚词，避免「词云干净了、常用语还在数 的/了/我」。

`warmJiebaDict` 还会把同一份词典通过 `setDefaultSegmenter` 装给 `@weq/agentlab`，让
`persona.ts` 的「常用语」(`topTerms`) 和 `http.ts` 的关键词提取共享同一套切法 —— 它们原先按
「非中英数字符即分隔」切，整段中文会变成一个 token（`下载链接` 这种），装上词典后才按词切。

## 接线

`apps/desktop/src/main/context/app_context.ts` 在 `UserConfigService` 构造后 fire-and-forget 调
`void warmJiebaDict([platform.jiebaDictDir(), resolveResource('jieba')])`。桌面端主进程的年度报告 /
群聊分析 / 私聊统计 / WeQ 助手周报 / MCP `get_group_activity` 全走同一份 `segmentWords`，一处加载
处处受益。

## 实测收益（真实群消息 800 条）

| 词 | 原文出现 | 改前 | 改后 |
| --- | --- | --- | --- |
| 链接 | 14 条消息 / 168 token | ❌ 丢 | ✅ 链接(168) |
| 数据库 | — | 只有「数据」 | ✅ 数据库(35) |
| 安装包 | — | 只有「安装」 | ✅ 安装包(34) |
| 密钥 / 重启 / 二维码 | — | ❌ 丢 | ✅ 保留 |

性能：词典加载约 0.5–0.7s（一次性），切词吞吐与 ICU 同量级甚至略快，不是瓶颈。

## 测试

- `packages/agentlab/test/segment.test.ts`：手写小词典 + 小 HMM 夹具，覆盖 DP 切分、用户词典强制
  成词、HMM 兜底、缺 HMM / 缺词典的降级、`tokenizeText`。
- `packages/service/test/text_segment.test.ts`：QQ 词典用临时目录里的手写夹具，覆盖「QQ 优先」/
  「QQ 缺失时读随包 `resources/jieba`」/ 两份都缺失时返回空数组，以及词性白名单口径。
- `packages/platform/test/{linux,win32}_paths.test.ts`：`jiebaDictDir` 路径解析、缺失返回 null、
  不回退遗产路径、账号无关。

全部**不读真 QQ 数据、不联网**（见 [testing.md](./testing.md)）。
