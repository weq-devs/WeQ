# QQ 交互能力研究（2026-10-21）

本记录区分协议来源、代码接入、离线回归与真实 QQ 验收。未验证的业务语义不以命令名或模拟回包代替。

## 群分类与标签目录

### 已有依据与本轮接入

- `GetGroupJoinInfo` 复用 `0x88D_110` 群资料查询，额外请求 `GroupClassExt`（tag 8）与 `GroupClassText`（tag 18），分别映射为 `categoryId` / `categoryName`。字段未返回时保留 `null`，不默认为分类 0；不查询加群标准答案。
- 界面只展示当前群真实返回的分类，不内置未经证实的编号表，不枚举猜测服务端目录。名称缺失时展示真实编号，不编造名称。错群、读取失败或未取得编号时不启用标签写入。
- 分类写请求前重新读取当前群资料并检查编号，读取后复核账号与运行时；分类变化时不沿用旧编号。
- `0x967C/D/E_0` 的现有请求只含分类编号（以及增删时的标签名），不含目标群号。界面改称「分类标签目录」，不将其描述为对当前群 `tagRecord` 的修改。

### 仍未验收

- `GroupClassExt` 与标签目录参数的服务端兼容范围、标签 `id/type` 的具体含义、增删作用域和权限，仍需指定测试群的真实响应与客户端对照。未发送真实 QQ 写请求。
- 本轮没有宣称获取完整分类目录，也没有将标签目录增删宣称为当前群标签绑定或解绑；二者需要分别验证。
- 因此完整研究项仍保留未勾选；本轮只完成真实分类读取、去除手填与提交边界。

### 离线验证

- 协议 `group_join_info.test.ts`：5 项通过，包含分类请求字节、显式 0、缺失字段和错群响应。
- 桌面 `qq_actions_ui.test.ts` / `qq_actions_router.test.ts`：79 项通过，包含实际分类展示、未知分类禁止提交、分类变化与异步切源拦截。
- `@weq/protocol` 与桌面主进程／渲染进程类型检查通过；修改文件的 Biome 检查通过。
- 对新增分类区域做浅色 1280px、浅色 390px、深色 390px 离线截图检查，切换自定义强调色、plain / paper / grid 背景并启用减少动态效果，无横向溢出。此检查不代表真实 QQ 状态或完整桌面流程验收。

### 一手实现来源

- [Lagrange.Core 固定版本 D88DGroupInfo](https://github.com/LagrangeDev/Lagrange.Core/blob/20c2ba079b5ee67156bd71419ed54ea61a24e91f/Lagrange.Core/Internal/Packets/Service/Oidb_0x88D.cs)：tag 8、18 以及 tag 41 的 `TagRecords` 是不同字段。
- [SnowLuma 分类标签定义](https://github.com/SnowLuma/SnowLuma/blob/38fc636088b98aa35a969b2aabe240d57b04dbf0/packages/proto-defs/src/oidb-actions/group-category-tag.ts)：分类查询和增删请求无群号。
- [NapCat 群资料类型](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-core/types/group.ts)：`classExt`、`groupClassText`、`tagRecord` 分开定义。仅用作字段交叉参考，不引入其运行模块。

## 私聊动态系统卡片

- 现有 `qqDynamic` 元素已支持 JSON `jump_schema` → `mqqapi://qzoneschema` → `mqzone://arouse/detail` 的 `appid=311` 说说目标，并已有组件点击回归。
- 这不覆盖所有系统消息载荷。下一步需要定位用户所指失败卡片的具体元素类型和脱敏载荷，不能从「动态」文案或发布者 QQ 号猜测跳转目标。
