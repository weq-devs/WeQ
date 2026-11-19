# 官方公告维护

正式版本由 `weq-devs/WeQ` 的发版工作流自动发布公告。手动发布、修订、撤回只由官方仓库的维护者或管理员执行；两种方式均使用项目发布签名密钥，客户端没有发布入口。

## 正式版自动公告

正式版的签名更新索引发布成功后，`publish-announcement` 从该标签的 `CHANGELOG.md` 提取当版正文，使用 Release 的实际发布时间生成一条普通公告。测试版不发公告。脚本签名并读回验签，只追加新公告；已有同版本公告时不覆盖、不产生新修订。达到清单条数或大小上限时任务失败，不会丢弃历史；可手动整理清单再重跑失败任务。

公告任务失败不会撤销已公开的 Release 或拦住其他分发任务。若替换时丢失线上文件，从失败任务的 `announcement-backup-*` 产物恢复替换前签名文件后，再重跑失败任务。手动编辑时不要与自动发布同时运行。

## 手动发布与修订

在仓库根目录运行，输入是当前要保留的完整 JSON 数组：

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

版本发布公告可加 `"releaseVersion": "2.8.0"`，填正式发布标签中去掉 `v` 的版本号。更新索引可用后再发布公告；发布脚本会为正文补上该版本的官方 GitHub Release 链接，供不支持按钮的旧客户端使用。不要为了控制按钮给公告加 `<2.8.0` 的 `versionRange`：客户端会自行比较宿主版本，升级后只隐藏按钮、保留正文。

`check` 只做本地校验。`publish` 先核已登录 `gh` 在官方仓库的角色（`MAINTAIN` 或 `ADMIN`），再使用现有 `WEQ_RELEASE_SIGNING_KEY`。未设置该变量时，macOS 读取 `~/Library/Application Support/WeQ-release/release-metadata-ed25519.pem`。脚本只更新 `weq-update-feed` 下的 `announcements-v1.json`，读回验签才报成功。一次只运行一个发布进程。

替换前的签名文件保存在 `WEQ_ANNOUNCEMENT_BACKUP_DIR`，默认为 `~/Library/Application Support/WeQ-release/announcements`。如果脚本确认线上文件因替换失败而缺失，使用报告的备份路径执行 `gh release upload weq-update-feed /path/to/announcements-v1.json --repo weq-devs/WeQ` 恢复，再重新发布；线上文件仍在时不用旧修订覆盖。已运行的客户端每 15 分钟检查一次，也可在公告页手动刷新。
