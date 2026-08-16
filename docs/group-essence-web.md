# 群精华消息 Web API 补充实现

## 概述

本次实现为 WeQ 的群精华消息功能添加了 Web API 支持，用于补充数据库中缺失的消息内容。

## 实现架构

### 后端实现

#### 1. Web API 封装
- **位置**: `packages/service/src/web/group-essence.ts`
- **接口**: `https://qun.qq.com/cgi-bin/group_digest/digest_list`
- **认证**: 使用 Cookie（通过 `bkn` 参数从 skey 计算）
- **分页**: 支持 `pageStart` 和 `pageLimit` 参数
- **返回数据**: 包含消息序号、消息内容（文本/表情/图片/文件）、发送者、时间等

#### 2. 消息内容解析
- **文本消息** (type=1): 纯文本内容
- **表情消息** (type=2): QQ 表情索引
- **图片消息** (type=3): 图片 URL
- **文件消息** (type=5): 文件名和大小
- **未知类型**: 保留类型标记，前端友好提示

#### 3. Service 层集成
- **位置**: `packages/service/src/groups/GroupInfoService.ts`
- **方法**: `getEssenceMessagesWithContent()`
- **策略**: 
  1. 优先从数据库读取基础信息（msgSeq、random、时间戳等）
  2. 如果有在线账号或有效 Cookie，调用 Web API 补充消息内容
  3. 按 msgSeq 匹配，合并数据库和 Web API 的结果

#### 4. Router 接口
- **位置**: `apps/desktop/src/main/ipc/routers/account.ts`
- **接口名**: `getGroupEssenceWithContent`
- **参数**: `groupCode`, `pageStart`, `pageLimit`
- **返回**: 包含完整消息内容的精华消息列表

### 前端实现

#### 1. 数据加载
- **位置**: `apps/desktop/src/renderer/src/views/MainView.tsx:2556`
- **策略**:
  - 并行加载数据库精华列表（`listGroupEssenceMessages`）
  - 并行尝试 Web API 补充内容（`getGroupEssenceWithContent`）
  - 按 `msgSeq` 匹配合并两个数据源
  - Web API 失败不影响数据库数据的展示

#### 2. 消息渲染
- **位置**: `apps/desktop/src/renderer/src/im-template/template/groupInfoPanel.tsx:276`
- **特性**:
  - 卡片式布局，显示发送者、设置精华的人、时间
  - 支持多种消息元素类型渲染
  - 点击卡片跳转到对应消息（通过 `msgSeq`）
  - 如果没有消息内容，显示"已设为精华"占位符

#### 3. 样式设计
- **位置**: `apps/desktop/src/renderer/src/styles/index.css`
- **特点**:
  - 现代卡片设计，hover 效果
  - 明暗主题支持
  - 图片预览、文件显示、表情标记
  - 响应式布局，适配不同屏幕

## 使用流程

### 数据展示优先级
1. 先展示数据库中的精华列表（msgSeq、时间、操作者）
2. 如果有在线账号/有效 Cookie，异步补充消息内容
3. 内容加载后自动更新 UI，无需刷新

### 消息跳转
- 点击精华消息卡片，通过 `msgSeq` 跳转到聊天记录中的对应位置
- `msgSeq` 是 QQ 消息的唯一序号，确保跳转准确

## 测试

### 测试脚本
- **位置**: `packages/service/test/group-essence-web.test.ts`
- **用途**: 验证 Web API 是否正常工作
- **使用**: `pnpm -F service tsx test/group-essence-web.test.ts`

### 测试结果示例
```
群精华消息 (共 14 条):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Seq: 123456  发送: Member  设置: Admin
   📅 2024-01-15 14:30:22
   💬 消息内容：[文本] 这是一条精华消息
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 关键技术点

### msgSeq 的重要性
- `msgSeq` 是 QQ 消息的唯一序号，用于：
  - 匹配数据库和 Web API 的同一条消息
  - 实现消息跳转功能
  - 确保精华消息的唯一性

### Web API vs 数据库
- **数据库**: 快速、离线可用，但缺少消息内容
- **Web API**: 包含完整消息内容，但需要在线和 Cookie
- **组合策略**: 数据库保底 + Web API 增强，提供最佳用户体验

### 错误处理
- Web API 请求失败不影响数据库数据展示
- Cookie 过期时自动降级到纯数据库模式
- 前端设置 `retry: false` 避免反复请求失败的 API

## 后续优化方向

1. **缓存策略**: Web API 结果可以缓存 5 分钟（已设置 `staleTime`）
2. **分页加载**: 当前只加载前 50 条，可以添加"加载更多"
3. **消息预览**: 可以在精华列表中直接预览图片大图
4. **搜索功能**: 支持在精华消息中搜索关键词
