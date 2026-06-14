# resources/

仓库级静态资源总集（与 `native/`、`packages/`、`apps/` 平级）。这里放**与具体应用解耦、可被多处复用**的资源，按用途分子目录：

- `brand/` — 品牌素材（应用 logo / 图标等）。
  - `logo.png` — 应用主 logo，用于窗口图标、首页与统计面板。
- 后续可新增：`emoji/`（QQ 表情）、`fonts/`、`illustrations/` 等。

## 引用方式

- **渲染进程（React）**：用 `@resources` alias 导入，vite 会打包进 `out/renderer/assets/`。
  ```ts
  import logoUrl from '@resources/brand/logo.png';
  ```
- **主进程（运行时读文件）**：见 `apps/desktop/src/main/index.ts` 的 `resolveResource()`——
  开发期从仓库 `resources/` 解析，打包后从 `process.resourcesPath/resources/` 解析
  （由 `apps/desktop/electron-builder.yml` 的 `extraResources` 拷入）。

新增资源时：放进对应子目录即可，无需改构建配置（整个 `resources/` 已被 vite alias 与
electron-builder 一并纳入）。
