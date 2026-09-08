# 测试约定

WeQ 的验证代码只有一层单测，**判据是「能不能无人值守跑」**，而不是「当时在调查什么」。
放错层的直接后果是：CI 跑不了的东西混进 CI，或者会改你 QQ 数据的脚本被误触发。

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts` | 否 | ✅ `pnpm -r test` | 离线、可重复、有断言 |

> 历史：曾经还有一层 `packages/tools/` CLI 工具（发任意包、跑任意 SQL、写库 mutate）。
> 2026-09 重构时已删除——其中产品化的能力（SQL 执行、凭证获取、协议发包等）已并入
> 内置 MCP 工具（`apps/desktop/src/main/mcp/tools.ts`，见 `docs/guide/mcp-server.md`），
> 其余探针类脚本由单测覆盖或直接移除。

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

---

## 该放哪一层？

- 有断言、不碰真库 → `packages/<pkg>/test/`，写成 `*.test.ts`
- **一次性调查，结论已经沉淀进 `docs/`** → 别留，删掉

最后一条是有代价的经验（2026-09 大清理）：`packages/*/tools/` 曾堆了 165 个脚本，
其中九成是「验证 src 已有能力」的一次性探针 —— 结论早写进 docs 和单测了，脚本留着只会
让人不敢删也不敢跑。**调查产物的归宿是文档和单测，不是 `tools/` 目录。**

---

[← 返回开发者入口](./index.md)
