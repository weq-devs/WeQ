# 测试约定

| 层 | 位置 | 要真 QQ 吗 | 进 CI 吗 | 干什么用 |
|---|---|---|---|---|
| **单测** | `packages/*/test/*.test.ts`、`apps/desktop/test/*.test.ts` | 否 | ✅ `pnpm -r test` | 离线、可重复、有断言 |

---

## 单测 `test/`

vitest 跑，**不许碰 QQ 数据库、不许联网**。每个含单测的包/应用都声明 `test: vitest run`，
`pnpm -r test` 逐个跑（CI 也是这条）。数据用抓包/dump 出来的黄金样本硬编码在文件里；
需要 DB 行为的用 `@weq/testkit` 的 `createSqliteStub()`（node:sqlite 假绑定）对
**明文 SQLite 夹具**跑真的 src 代码路径。

```bash
pnpm -r test                      # 全量（CI 跑的就是这条）
pnpm --filter @weq/codec test     # 单个包
pnpm --filter @weq/codec test:watch
pnpm --filter @weq/desktop test   # 桌面端主/渲染进程的纯逻辑单测
```

`apps/desktop` 的单测默认跑在 **happy-dom** 环境（`apps/desktop/vitest.config.ts`），
因为渲染进程的投影器直接吃 `DOMParser`。主进程纯逻辑单测在 DOM 环境下同样能跑，
所以只配了一个环境。

写的时候注意两件事，都是真踩过的坑：

- **断言别复制常量的字面量**。`scupdate.test.ts` 曾把 QQ 版本号写死成 `'8.8.17.5770'`，
  src 里升到 `9.3.5.37250` 后测试就成了假警报。要断言就 import 那个常量。
- **拿「未声明字段」举例时挑个远离已用区间的 tag**。`registry.test.ts` 曾用 tag 47608 当
  未知字段，后来 47608 被建模成 `faceFlag47608`，测试就炸了。

---

[← 返回开发者入口](./index.md)
