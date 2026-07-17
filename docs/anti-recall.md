# WeQ 防撤回（Anti-Recall）设计与验证记录

> 本文沉淀「SQL trigger 防 QQ 消息撤回」全部**已用真库验证**的事实与最终架构。
> 每个结论后标了验证脚本（都在 `packages/db/test/`）。重开对话/换人接手，先读这份。

---

## 1. QQ 撤回在磁盘上到底是什么

**撤回 ≠ 删除**，两者机制完全不同：

| 操作 | 磁盘行为 | 标量特征 |
|---|---|---|
| **删除**（屏蔽单条，可删自己/别人） | 40011/40012 → (1,1)，40800 body 保留 | `40011=1 AND 40012=1` |
| **撤回** | **同一行就地 UPDATE**：40800 body 改写成撤回灰条 protobuf，40011/40012 → (5,4) | `40011=5 AND 40012=4` |

撤回是**单次 UPDATE 同时改 40800 + 40011/40012**（`snapshot_msg.ts` 前后对比：整行只有这几列 + 40600 变，40002 等其余全不变）。

### 撤回的标量指纹 5/4 是干净的
`probe_revoke_signature.ts` 扫 2 万行：group / c2c 里 `(40011=5,40012=4)` 桶 **100% 是撤回灰条，零污染**。其它灰条（群通知 5/12、系统 5/8、5/17、5/11…）都在别的桶。→ 识别撤回**不需要解 protobuf**，标量即可。

---

## 2. Trigger 拦截方案

### 判据：盯 40800 变动（不是盯 5/4）
最终 `WHEN` 用 **`NEW.40800 IS NOT OLD.40800`** 作主判据（body 被改写 = 撤回/编辑），5/4 当双保险。原因：只盯 5/4 会漏掉「body 已被改、type 还没翻」的中间态。`BEFORE UPDATE` 里 `SELECT RAISE(IGNORE)` 静默取消该行 UPDATE，QQ 收到「成功」不报错、不崩，原文留在磁盘。

### QQ 容忍度（已验证）
- QQ **正常启动**，不因库里有陌生 trigger 判损坏（`anti_recall_trigger.ts`）。
- QQ 重启后**不清除**我们的 trigger。
- 现有 trigger 数：0（白板，QQ 自己不装 trigger）。

### 放行 WeQ 自己的写：bump 40002
撤回**不动 40002**（msgRandom），验证见 `snapshot_msg.ts`（真实撤回前后 40002 均 1658100565）。
→ WeQ 主动改 body 时，**同一条 UPDATE 里顺手改 40002**，WHEN 里加 `AND OLD.40002 IS NEW.40002` → WeQ 的写因 40002 变了而放行；QQ 撤回 40002 不变被拦。写操作被 EXCLUSIVE 锁串行化，无竞态。
（40002 是 UNIQUE 索引成员：c2c `(40027,40002,40005)` / group `(40027,40003,40002)`，bump 时新值需避免撞同分区。）

---

## 3. ☠️ 最大的坑：Trigger 里 `OLD."列"` 不带列亲和

**症状**：私聊拦截成功、群聊拦不住。
**根因**（`diag_audit_trigger.ts` 审计 trigger 实测 `in_num=1 / in_str=0`）：
- 表列 `40027`（群号）声明为 INTEGER，有 NUMERIC 亲和。普通 `SELECT ... WHERE "40027" IN ('673646675')` 会把字符串按列亲和转 int → **命中**（这误导了我们很久）。
- 但 **trigger 里 `OLD."40027"` 是表达式，不继承列亲和**。`OLD."40027" IN ('673646675')` = INTEGER vs TEXT → SQLite 判不等 → **WHEN 永不命中** → 群聊撤回漏过。
- c2c 的 `40021`（uid）本就是 TEXT，`OLD."40021" IN ('u_...')` = text vs text，天然匹配，所以私聊一直好。

**修复**（`anti_recall.ts`）：`TableSpec.filterNumeric` 标志。数字列（group 40027）IN 列表出**裸整数**（`IN (673646675, ...)`），文本列（c2c/dataline 40021）出**引号字符串**。非数字 id 混进数字列则丢弃（防御 `u_` 误标 group）；列表空则不建 trigger（避免 `IN ()` 语法错）。
**教训**：验证 trigger 语义必须用 trigger 本身（审计 trigger 写日志表），不能用 SELECT 代验——两者亲和规则不同。

---

## 4. 自定义灰条：走 tipJson（subType=17），不走 protobuf 撤回灰条

### 为什么 tipJson 最优
样本 `7737024164892267232`（群精华灰条）解剖（`dissect_tipjson.ts`）：内容是 **JSON 文本**塞在 protobuf field 48271，uin/nick/seq 全是 JSON 里的**可打印文本子串**，可点击深链接跳转（`tencent://` 资料卡、`mqqapi://NTGroup/essence` 跳消息）。
→ 拼灰条 = **文本 format 替换**，不碰二进制 wire 编码。远优于 protobuf 撤回灰条（那个 nick/uid 是二进制变长字段，SQL 提取塞 JSON 极痛苦）。

### 40800 分层结构（432B 样本）
```
82f613 <len varint>            MsgBody field#40800 (wire=LEN)
  c8fc15 <varint>  #45001 elementId   (随消息变，可复用OLD或固定)
  d0fc15 08        #45002 elementType = 8   固定
  d8fc15 11        #45003 subType    = 17  固定
  fac817 <len varint(2B)>  #48271 tipJson (JSON文本)  ← uin/nick/seq 在这
  80c917 00        #48272 = 0        固定
  88c917 e112      #48273 tipType = 2401  固定
  98c917 00        #48275 = 0        固定
```
tipJson 长度永远 < 16384（nick≤36B、uin~10B、seq~10B）→ **两层长度前缀恒为 2 字节 varint**，无需处理 1/2/3 字节分支。

### SQL 拼 protobuf 的关键函数（QQ SQLCipher = SQLite 3.45.3，已验证支持）
`probe_sqlite_fns.ts` 全绿：
- `unhex('85037b22')` → blob，**干净生成任意字节，绕开 char() 的 UTF-8 膨胀坑**。
- 动态长度前缀：`unhex(printf('%02x%02x', (L & 127)|128, (L>>7)&127))` → 2字节 varint。
- **拼接结果默认 typeof=text（遇 0x00 length 截断），最外层必须 `CAST(... AS BLOB)`**，套了就是完整 blob。
- uid 用 `CAST('u_...' AS BLOB)` 嵌入，字节正确。
坑记录：`char(N)` 返回 UTF-8，`char(200)=C388`（≥128 膨胀），**动态字节一律用 unhex 不用 char**。

### ✅ 已验证的 tipJson 灰条 SQL 拼装模板（`probe_build_tipjson.ts` 跑通，codec 解码正确）
纯 SQL 拼出的 blob 被 `decodeBody` 解出 `kind:grayTipPoke / elementType:8 / subType:17`，uin/nick 正确嵌入。模板：

固定字节（来自 `dissect_tipjson.ts` 解剖参考样本 7737024164892267232）：
```
EL_HEAD = c8fc15 d3a5efcfc6cff0ab6a d0fc1508 d8fc1511   (#45001 elementId + #45002=8 + #45003=17)  20B
TIP_TAG = fac817                                          (#48271 tipJson tag)  3B
EL_TAIL = 80c91700 88c917e112 98c91700                    (#48272=0 #48273=2401 #48275=0)  13B
```
tipJson 文本 = `pre || UIN || mid || json转义(NICK) || post`，其中：
- pre = `{"align":"center","items":[{"col":"3","jp":"tencent://ntqq-open?subCmd=profile&action=openMiniBuddyProfile&actionParams=%7B%22uin%22%3A%22`
- mid = `%22%2C%22sourceType%22%3A%22QrCodeShareBuddyLink%22%7D","txt":"`
- post = `","type":"url"},{"txt":"撤回了一条消息","type":"nor"}]}`
- NICK 的 JSON 转义：`replace(replace(NICK, '\', '\\'), '"', '\"')`

40800 blob 组装（两层动态长度前缀，都是 2 字节 varint）：
```sql
CAST(
  X'82f613'
  || unhex(printf('%02x%02x',                       -- 外层 MsgBody 总长
       ((23 + 2 + length(CAST(tip AS BLOB)) + 13) & 127) | 128,
       ((23 + 2 + length(CAST(tip AS BLOB)) + 13) >> 7) & 127))
  || X'<EL_HEAD>' || X'<TIP_TAG>'
  || unhex(printf('%02x%02x',                        -- tipJson 长度前缀
       (length(CAST(tip AS BLOB)) & 127) | 128,
       (length(CAST(tip AS BLOB)) >> 7) & 127))
  || CAST(tip AS BLOB)
  || X'<EL_TAIL>'
AS BLOB)
```
关键：`23 = len(EL_HEAD)+len(TIP_TAG) = 20+3`，`13 = len(EL_TAIL)`，`2 = tipJson长度前缀字节数`。中文用 `length(CAST(tip AS BLOB))` 取**字节数**（非字符数）。踩坑：算外层长度时别把 TIP_TAG 的 3 字节重复计（EL_HEAD+TIP_TAG 已合并进 23）。

---

## 5. 最终架构（方案 C：trigger 拦截+记录，JS 补插灰条）

> ⚠️ 曾走过「路线甲：纯 SQL trigger 自治（拦截+记录+同表补插灰条+RAISE）」，**真机失败**。
> 见 §5.1 那个深坑。最终改为方案 C。

trigger 只干两件事——**绝不在 trigger 里 INSERT 同表补插灰条**：
```sql
BEFORE UPDATE ON <msg_table>
WHEN OLD."40002" IS NEW."40002"
  AND OLD."<filterCol>" IN (<会话列表，按 filterNumeric 定字面量形态>)
  AND ( NEW."40800" IS NOT OLD."40800"
     OR NEW."40900" IS NOT OLD."40900"
     OR (NEW."40011"=5 AND NEW."40012"=4 AND (IFNULL(OLD."40011",-1)<>5 OR IFNULL(OLD."40012",-1)<>4)) )
BEGIN
  -- ① 记录（我们自己的表，QQ 不碰）。msgid 是 PK + OR IGNORE → 单事务3连击只留一行。
  INSERT OR IGNORE INTO weq_recall_log(msgid, conv, table_kind, sender_uid, revoke_uid, orig_seq, recall_ts, orig_body)
    VALUES(OLD."40001", CAST(OLD."<filterCol>" AS TEXT), '<kind>',
           OLD."40020",                                    -- 原作者 uid
           <substr 从 NEW.40800 提取 revokeUid>,            -- 谁撤的
           OLD."40003", strftime('%s','now'), OLD."40800");
  -- ② 取消撤回，保原文。补插灰条不在这里！见 §5.1。
  SELECT RAISE(IGNORE);
END
```
灰条补插由 **WeQ JS** 完成：轮询 `weq_recall_log` 里 `graytip_done=0` 的行 → 用 `appendClonedRow`（`msg/append.ts`）+ codec 生成 tipJson 灰条（subType=17）补插到对应会话 → 置 `graytip_done=1`。§4 那套 SQL 拼 tipJson 的知识改用在 JS 里（codec 直接生成 blob，比 SQL 拼更简单，但 tipJson 文本模板/深链接格式相同）。

### 5.1 ☠️☠️ 核心深坑：RAISE(IGNORE) 会废掉「同事务里补插的 INSERT」

**症状**：trigger 装 `记录 + 同表补插灰条 + RAISE(IGNORE)`，QQ 撤回后——拦截成功（原文保住），但**记录表 0 行、灰条 0 条**，两条 INSERT 全没落地，且 SQLite 不报错（被 IGNORE 吞）。

**排查（每步都真库/审计 trigger 验证）**：
1. `RAISE(IGNORE)` 前的最小**异表** INSERT（单条手动 UPDATE 触发）→ 留存 ✅（`probe_raise_insert.ts`）
2. 两条 INSERT 单独在普通连接跑 → 都成功 ✅（`probe_full_insert.ts`）
3. BEFORE UPDATE 里 INSERT 同表（最小灰条）+ RAISE → 落地 ✅（`probe_sametable_insert.ts`）
4. 装**真实 trigger** + **手动** 1 次 UPDATE 触发 → 记录+补插全成功 ✅（`probe_real_trigger_manual.ts`）
5. 审计 QQ 真实撤回（不拦截）→ **QQ 撤回是单事务 3 连击 UPDATE**，body 52→88→128→153，每击 would_fire=1（`audit_qq_recall.ts`）
6. 真实 trigger + QQ 撤回 → 记录 0、灰条 0 ❌（`audit_with_real.ts`）

**根因**：单条 autocommit UPDATE 下 RAISE(IGNORE) 只取消该行、保留前面的 INSERT；但 **QQ 撤回是「单个事务里 3 连击 UPDATE」**，在这种多语句事务上下文里，`RAISE(IGNORE)` 连带把**同事务里 trigger 补插的 INSERT 一起废掉**。手动测试之所以全成功，是因为手动是各自 autocommit，不是单事务——**这是本次排查最大的方法论陷阱：手动模拟 ≠ QQ 单事务**。

**验证「只记录+RAISE」能否活**（`verify_record_survives.ts`，真机）：记录表 INSERT **能活** ✅、原文保住 ✅、revoke_uid 提取成功 ✅。→ 所以拆分：trigger 只记录（异表，能活）+ RAISE；补插（会被废的同表 INSERT）挪到 JS。

**教训**：① 凡涉及 trigger + RAISE 的验证，必须用**真机 QQ 撤回**（单事务），不能用手动 `db.write`（autocommit）代验。② trigger 里能安全做的只有「异表 INSERT + RAISE」；「同表补插」在 QQ 事务里必废。

### 变量来源分工（OLD/NEW 分开，不丢信息，展示交给前端/JS 拼）
- **记录表存"谁撤的" revoke_uid**：SQL 从 **NEW.40800** 提取。已验证（`probe_recall_uid_extract.ts` + 真机 `verify_record_survives.ts`）：
  - `instr(NEW."40800", X'c2a517')` 定位 field 47704(recallRevokeUid) tag，`+4` 跳过 3B tag+1B len(0x18)，`substr(...,24)` 切出 uid。
  - `X'baa517'` = field 47703(recallSenderUid)。uid 恒 24B（41万行零例外）。
  - `revoke_uid == sender_uid` → 本人撤回；`!=` → 管理员撤他人。
- **JS 补插灰条显示的 nick/uin**：从记录表 `sender_uid` + `orig_body`(原文) 拿，或查会话 profile。

### 补插行主键/递增规则（JS 侧 appendClonedRow，用户拍板）
三表结构一致（38列、PK=40001、NULL列通用 40801/40900/40062）：
- `40001` = 原值 + random(10~50)   `40002` = random   `40003` = OLD.40003 + 1   `40008` = OLD.40008 + 1
- 时间列（40050/40058）= 撤回时刻   分区列（group 40027 / c2c·dataline 40021）= 复制 OLD
- 40011/40012 = 5/17（grayTipPoke）   40800 = codec 生成的 tipJson blob   其余非固定列留 NULL/clone

---

## 6. 生命周期 / 运维约束

- **改 trigger 必须先关 QQ**：DDL 抢 EXCLUSIVE 锁；且 QQ 只在启动时重读 schema，重装的 trigger 下次启动才对 QQ 生效。「能改数据 ⟺ 能改 trigger」，关 QQ 是为「让 QQ 重读 schema」不是权限问题。
- `CREATE TRIGGER IF NOT EXISTS` 不覆盖 → 改定义必须 DROP + CREATE（`reconcile` 已这么做）。
- `QqDb.write` 用完 `finally closeDb` 释放锁，否则锁死 QQ 本体。
- trigger 里**禁止调 native 注册的自定义 SQL 函数**：trigger 跑在触发写入的连接上（撤回时=QQ 连接），QQ 没注册 → `no such function` → QQ 崩。只能用内置函数（instr/substr/unhex/printf/CAST/…）。

---

## 7. 关键文件

- `packages/db/src/msg/anti_recall.ts` — `AntiRecallDb`：trigger 安装/reconcile/status/uninstall
- `packages/service/src/account/anti_recall.ts` — `AntiRecallService`：per-account 配置 + 生命周期
- 测试/探测脚本（`packages/db/test/`）：
  - `anti_recall_trigger.ts` — 最初纯拦截版 install/uninstall/status
  - `snapshot_msg.ts` — 撤回前后逐列对比（证 40002 不变）
  - `probe_revoke_signature.ts` — 5/4 指纹纯度
  - `diag_audit_trigger.ts` — **审计 trigger 写日志表**，定位 OLD 列无亲和根因
  - `dissect_tipjson.ts` — tipJson 灰条分层解剖
  - `probe_sqlite_fns.ts` — unhex/printf 支持验证
  - `probe_recall_uid_extract.ts` — SQL 从 NEW.40800 提取撤回者 uid

## 8. 状态

- ✅ 拦截（group + c2c + dataline，含 40027 亲和修复）——**已上线工作**
- ⏳ 记录表 weq_recall_log + tipJson 灰条补插——设计完成，待实现（见任务 #2/#3/#4）
- 🔮 后续：前端读 weq_recall_log 展示「撤回消息」面板
