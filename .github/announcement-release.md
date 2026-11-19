# 官方公告维护

发布、修订、撤回只由官方仓库 `weq-devs/WeQ` 的维护者或管理员执行，并使用项目发布签名密钥。贡献者和具有 `WRITE` 权限的账号不能通过公告发布脚本发布；客户端没有发布入口。

公告不跟随应用发版。在仓库根目录运行，输入是当前要保留的完整 JSON 数组：

```bash
node scripts/publish-announcements.mjs check /path/to/announcements.json
node scripts/publish-announcements.mjs publish /path/to/announcements.json
```

一条公告的示例（填写 UTC 时间）：

```json
[
  {
    "id": "maintenance-example",
    "title": "服务维护通知",
    "body": "维护期间可继续浏览本地记录。\n\n[查看项目说明](https://weq-devs.github.io/WeqDocs/guide/)",
    "publishedAt": "2026-11-18T16:00:00Z",
    "level": "important",
    "remindUntil": "2026-11-19T16:00:00Z",
    "platforms": ["macos", "windows"],
    "versionRange": ">=2.7.0 <2.8.0"
  }
]
```

`level` 为 `normal` 或 `important`，只有后者填写 `remindUntil`。`platforms`、`versionRange` 各自可省略，表示不限；平台为 `macos`、`windows`、`linux`、`web`（仅独立 Web 部署）。连接桌面宿主的网页及 Remote 按该宿主匹配。修订保留 ID 和已读状态，需要重新提醒时使用新 ID。撤回从数组中移除该条，撤回全部则发布 `[]`；不要复用已撤回的 ID。

`check` 只做本地校验。`publish` 先核已登录 `gh` 在官方仓库的角色（`MAINTAIN` 或 `ADMIN`），再使用现有 `WEQ_RELEASE_SIGNING_KEY`。未设置该变量时，macOS 读取 `~/Library/Application Support/WeQ-release/release-metadata-ed25519.pem`。脚本只更新 `weq-update-feed` 下的 `announcements-v1.json`，读回验签才报成功。一次只运行一个发布进程。

替换前的签名文件保存在 `WEQ_ANNOUNCEMENT_BACKUP_DIR`，默认为 `~/Library/Application Support/WeQ-release/announcements`。如果脚本确认线上文件因替换失败而缺失，使用报告的备份路径执行 `gh release upload weq-update-feed /path/to/announcements-v1.json --repo weq-devs/WeQ` 恢复，再重新发布；线上文件仍在时不用旧修订覆盖。已运行的客户端每 15 分钟检查一次，也可在公告页手动刷新。
