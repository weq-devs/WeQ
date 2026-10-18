# 原生 QQ 邮箱

使用方式见[QQ 邮箱](../guide/qqmail.md)。邮箱复用当前 QQ 登录态，不走 IMAP，也不在渲染进程承载登录网页。

## 安全与生命周期

- `account/mail/` 管理账号级 CookieJar、ptlogin、sid、CGI、附件及提醒；票据只驻留主进程内存，不进入 DTO、配置或日志。
- IPC 捕获当前账号及服务实例；切号、关闭账号和断开取消请求并销毁连接。晚到响应不能重新写入已销毁的 CookieJar。
- HTML 经 DOMPurify、隔离 iframe 和 CSP 处理，默认阻断远程图片。主进程用 parse5 隐藏内嵌资源签名，图片以不透明句柄代理，不把凭据 URL 交给页面。
- 发送区分接受、拒绝和结果未知。提交后连接中断不自动重发；服务端接受也不代表最终投递。
- 附件只接受宿主选择的文件与服务注册的句柄；下载保留同名原件，检查容量、大小及受信任跳转，不执行附件。

## 易回归点

- 通用 clientKey jump 与邮箱专用 SSL check_sig 域配合，不把不适用的 appid jump 当唯一登录入口。
- 网页登录可能清除面板提醒所需的 `p_skey`。面板票据单独驻留内存，仅向精确限定的 HTTPS 提醒地址发送，销毁时清除。
- 轮询失败不阻断 WebSocket；握手建立基线，版本变化补查，事件去重。系统通知不展示邮件主题和发件人。
- 重选当前文件夹必须触发刷新代次，不能只清空列表；账号订阅回调保持稳定，晚到旧列表不能覆盖新结果。
- `ws` 也须是桌面端生产依赖，以便 `externalizeDepsPlugin` 保留其 Node 加载和可选加速模块回退；不能强制引入 `bufferutil` 才让应用启动。
- 附件 hash 复用协议包的 `Sha1Stream`，分片中间状态与末片标准 SHA1 语义不同，不另造 hash 实现。

## 源码与验证

| 范围 | 入口 |
| --- | --- |
| 协议、认证、文件 | `packages/service/src/account/mail/` |
| IPC 与系统通知 | `apps/desktop/src/main/ipc/routers/mail.ts`、`main/mail_notify.ts` |
| 界面与正文隔离 | `apps/desktop/src/renderer/src/views/mail/` |
| 离线回归 | service 与 desktop 的 `qqmail*.test.ts`；`qqmail_bundle.test.ts` 还实际构建并加载 WebSocket 入口 |

离线夹具不能证明真实投递、附件传输或操作系统横幅均可用；这些需要独立端到端验收，不把历史门禁数字当当前版本状态。
