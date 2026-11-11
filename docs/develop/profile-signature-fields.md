# 签名与个人说明字段

QQ 的个性签名和「详细资料 → 个人说明」不是同一字段：

| 内容 | 内容字段 | 当前写入入口 |
| --- | --- | --- |
| 个性签名／长昵称 | 102 | `SetProfile.signature`、`SetSelfLongNick.longNick`、`SetSelfProfile.signature` |
| 个人说明 | 20019 | 尚未接入；Android 资料 TLV 使用独立字段 |

`SetProfile` 与 `ProfileService.setProfile` 以前把签名参数命名为 `personalNote`，容易与安卓详细资料的个人说明混淆。现在签名统一传 `signature`：

```ts
await profileService.setProfile({ signature: '新的个性签名' });
await profileService.setProfile({ signature: '' });
```

旧 `personalNote` 不再接受。即使未类型化调用将它与昵称等字段一起传入，也会在发包前明确报错，整份补丁不发送；不能把它静默解释为个人说明或继续写签名。需要更新直接使用旧参数的调用方。仓库现有界面签名编辑使用独立入口，不受此次参数迁移影响。

签名清空必须保留空字符串值字段，性别零值同样显式编码。空补丁保持不发包。后续接入个人说明时，必须独立定义 20019 的读写模型，不更改已有签名入口的字段含义。

针对性回归位于 `packages/protocol/test/profile_signature_field.test.ts` 与 `packages/service/test/profile_signature_field.test.ts`，均为离线编码／调用验证，不改真实账号资料。
