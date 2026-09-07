# 测试约定

WeQ 的验证代码分三层，**判据是「能不能无人值守跑」**，而不是「当时在调查什么」。
放错层的直接后果是：CI 跑不了的东西混进 CI，或者会改你 QQ 数据的脚本被误触发。

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts` | 否 | ✅ `pnpm -r test` | 离线、可重复、有断言 |
| **CLI 工具** | `packages/tools/*.ts`（`@weq/tools`） | 是 | 只过 typecheck | 产品没有的能力：发任意包、跑任意 SQL、全库搜索 |
| **写库工具** | `packages/tools/mutate/*.ts` | 是 | 只过 typecheck | 会改真实 QQ 数据，需 `--yes` |

---

## 单测 `test/`

vitest 跑，**不许碰 QQ 数据库、不许联网**。数据用抓包/dump 出来的黄金样本硬编码在文件里；
需要 DB 行为的用 `@weq/testkit` 的 `createSqliteStub()`（node:sqlite 假绑定）对
**明文 SQLite 夹具**跑真的 src 代码路径。

```bash
pnpm -r test                      # 全量（CI 跑的就是这条）
pnpm --filter @weq/codec test     # 单个包
pnpm --filter @weq/codec test:watch
```

写的时候注意两件事，都是真踩过的坑：

- **断言别复制常量的字面量**。`scupdate.test.ts` 曾把 QQ 版本号写死成 `'8.8.17.5770'`，
  src 里升到 `9.3.5.37250` 后测试就成了假警报。要断言就 import 那个常量。
- **拿「未声明字段」举例时挑个远离已用区间的 tag**。`registry.test.ts` 曾用 tag 47608 当
  未知字段，后来 47608 被建模成 `faceFlag47608`，测试就炸了。

## CLI 工具 `packages/tools/`

保留标准只有一条：**这个能力必须是 WeQ 产品本身没有的**。验证 src 能力的探针不是工具
—— 那是单测（或干脆删掉）。目前只有四个：

```bash
pnpm --filter @weq/tools packet -- ...        # 发任意 OIDB/裸包 + 回放 frida 抓包
pnpm --filter @weq/tools sql -- nt_msg "..."  # 对 nt_db/ 下任意库执行任意 SQL（.tables/.cols/.schema/.row）
pnpm --filter @weq/tools search-string -- kw  # 全库全表全列的裸字符串搜索
pnpm --filter @weq/tools mutate:insert-group-msg --yes  # 往真库插一条消息，看真 QQ 怎么渲染
```

跑之前先配 `.env`（`cp .env.example .env`，填 `WEQ_TEST_QQ_ROOT` 和 `WEQ_TEST_DB_KEY`）。
**不要在脚本里硬编码路径和密钥** —— 一律走 `@weq/testkit`。

工具不进 CI（没有真机数据），但**进 typecheck** —— 重构 src 时不会悄悄把工具写挂。
写新工具前先问一句：产品里是不是已经有了？有 → 别写，写单测。

## 写库工具 `packages/tools/mutate/`

会**真的改你的 QQ 数据**：插消息等。单独放一层就是为了让「这脚本会写库」在路径上一眼可见。

每个入口必须调守卫，不带 `--yes` 直接抛错退出：

```ts
import { requireMutationConsent } from '@weq/testkit';

async function main() {
  requireMutationConsent('往 group_msg_table 插入一条伪造的群消息');
  // ...
}
```

自动化场景可以用 `WEQ_ASSUME_YES=1` 绕过。**跑之前先退出 QQ** —— QQ 持有同一个
文件，并发写可能失败或锁库。

---

## 该放哪一层？

- 有断言、不碰真库 → `packages/<pkg>/test/`，写成 `*.test.ts`
- 产品没有的能力、要连真库 → `packages/tools/`
- 会写真库 → `packages/tools/mutate/`，加守卫
- **一次性调查，结论已经沉淀进 `docs/`** → 别留，删掉

最后一条是有代价的经验（2026-09 大清理）：`packages/*/tools/` 曾堆了 165 个脚本，
其中九成是「验证 src 已有能力」的一次性探针 —— 结论早写进 docs 和单测了，脚本留着只会
让人不敢删也不敢跑。**调查产物的归宿是文档和单测，不是 `tools/` 目录。**

---

[← 返回开发者入口](./index.md)
