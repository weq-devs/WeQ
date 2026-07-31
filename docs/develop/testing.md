# 测试约定

WeQ 的验证代码分三层，**判据是「能不能无人值守跑」**，而不是「当时在调查什么」。
放错层的直接后果是：CI 跑不了的东西混进 CI，或者会改你 QQ 数据的脚本被误触发。

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts` | 否 | ✅ `pnpm -r test` | 离线、可重复、有断言 |
| **只读探针** | `packages/*/tools/*.ts` | 是 | 只过 typecheck | 对着真库 dump / 验证，人眼看输出 |
| **写库脚本** | `packages/*/tools/mutate/*.ts` | 是 | 只过 typecheck | 会改真实 QQ 数据，需 `--yes` |

---

## 单测 `test/`

vitest 跑，**不许碰 QQ 数据库、不许联网**。数据用抓包/dump 出来的黄金样本硬编码在文件里。

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

## 只读探针 `tools/`

对着**真实 QQ 数据库**跑，用来回答「这个字段到底存了啥」。不进 CI（没有真机数据），
但**进 typecheck** —— 这样重构 src 时不会悄悄把探针写挂。

```bash
pnpm --filter @weq/db      tools:group-msg
pnpm --filter @weq/service tools:msg-search
```

跑之前先配 `.env`（`cp .env.example .env`，填 `WEQ_TEST_QQ_ROOT` 和 `WEQ_TEST_DB_KEY`）。
**不要在脚本里硬编码路径和密钥** —— 一律走 `@weq/testkit`：

```ts
import { testEnv, qqDbPath } from '@weq/testkit';

const db = new GroupMsgDb(native.ntHelper, {
  dbPath: qqDbPath('nt_msg.db'),
  key: testEnv.key,
  algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
});
```

## 写库脚本 `tools/mutate/`

会**真的改你的 QQ 数据**：插消息、装 trigger、改 ARK 卡片。单独放一层就是为了让
「这脚本会写库」在路径上一眼可见。

每个入口必须调守卫，不带 `--yes` 直接抛错退出：

```ts
import { requireMutationConsent } from '@weq/testkit';

async function main() {
  requireMutationConsent('往 group_msg_table 插入一条伪造的群消息');
  // ...
}
```

```bash
pnpm --filter @weq/db mutate:insert-weq-assistant --yes
```

自动化场景可以用 `WEQ_ASSUME_YES=1` 绕过。**跑之前先退出 QQ** —— QQ 持有同一个
文件，并发写可能失败或锁库。

只读的子命令（比如 `anti-recall-trigger status`）应该在分支里跳过守卫，
别让只读操作也要 `--yes`。

---

## 该放哪一层？

- 有断言、不碰真库 → `test/`，写成 `*.test.ts`
- 要连真库看数据 → `tools/`
- 会写真库 → `tools/mutate/`，加守卫
- **一次性调查，结论已经沉淀进 `docs/`** → 别留，删掉

最后一条是有代价的经验：这三层结构落地前，`packages/db/test/` 下堆了 116 个文件，
其中 40 多个是防撤回那一次专题留下的 `diag_*` / `probe_*` 残骸。结论早就写进
`docs/guide/anti-recall.md` 了，脚本留着只会让人不敢删也不敢跑。
**调查产物的归宿是文档，不是 `test/` 目录。**

---

[← 返回开发者入口](./index.md)
