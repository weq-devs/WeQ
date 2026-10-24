# 视频编码：`t265`（QQ 自带的魔改 x265）

> 2026-10-25。记录本端视频编码的探测结果。**当前未完成**：参数结构体已逆出，
> 图像结构体（`x265_picture` 对应物）还没。

## 1. 为什么不能用系统 x265

和音频那边的结论一致：QQ 用的是**腾讯魔改版**编解码器，编进 `AVSDKPlugin`
（linux/macos 是 `libAVSDKPlugin.so` / `.dylib`，windows 是 `AVSDKPlugin.dll`）。

魔改版的符号前缀是 **`t265_`**（`t` = tencent），版本 `2.12.1|d542e84|R`。
与音频的 `t` 前缀 Opus 是同一套路。

**用系统 libx265 编出来的码流对端不一定能解** —— 与 Opus 那个坑同理，所以只能
用 QQ 自带的那一份。

## 2. 已确认的事实

### 2.1 导出符号（linux x64，7961 个导出）

```
t265_param_alloc / t265_param_free
t265_param_default / t265_param_parse / t265_param_config_preset
t265_encoder_open / t265_encoder_encode / t265_encoder_close
t265_encoder_headers / t265_encoder_reconfig
t265_encoder_notice_received_frames / t265_encoder_notice_unreceived_frames
t265_version
```

`t265_encoder_notice_received_frames` 这类是魔改新增的（标准 x265 没有），
推测用于通话场景的参考帧反馈。

**没有** `t265_picture_alloc` / `t265_picture_init` —— 图像结构体要自己构造。

### 2.2 加载方式

必须先以 `RTLD_GLOBAL` 加载系统 GnuTLS，否则 `libbugly.so` 的未定义符号
（`gnutls_free`）会让 `dlopen` 直接失败。与 `nt_helper/src/call/avsdk.rs` 里
Opus 的处理完全相同。

### 2.3 参数结构体布局（已逆出）

`t265_param_t` 的前 16 字节：

| 偏移 | 字段 | 默认值 |
| --- | --- | --- |
| 0 | `sourceWidth` | 0 |
| 4 | `sourceHeight` | 0 |
| 8 | `fpsNum` | 0 |
| 12 | `fpsDenom` | 1 |

后面靠 `t265_param_parse` 配置（**不要**按标准 x265 布局硬写后面的字段，会踩内存）：

| 参数名 | 生效偏移 | 备注 |
| --- | --- | --- |
| `bitrate` | 140 | kbps |
| `keyint` | 116 | |
| `qp` | 136 | |
| `repeat-headers` | 96 | |
| `tune` | 72 | 字符串指针（`"zerolatency"`） |
| `preset` | 72 | 同上，`ultrafast` 返回 -2（不认识） |

`param_parse` 认的键名（返回 0 即认识）：`source-width` / `source-height` /
`width` / `height` / `input-res` / `fps` / `fps-num` / `fps-denom` / `bitrate` /
`vbv-maxrate` / `vbv-bufsize` / `keyint` / `min-keyint` / `bframes` / `qp` / `crf` /
`rc-lookahead` / `tune` / `annexb` / `repeat-headers` / `log-level` /
`frame-threads` / `pools` / `input-csp` / `total-frames` / `max-nal-size` /
`slices` / `ref` / `scenecut` / `open-gop` / `no-info`。

⚠️ **但 `width` / `height` / `fps` 通过 `param_parse` 设置不生效**（返回 0 但结构体
没变），必须直接写偏移 0/4/8/12。

### 2.4 可用的自检输出

`t265_encoder_open` 成功后，会往 stderr 打一行完整配置，**这是逆向时的最佳
验证手段**：

```
t265 : [2.12.1|d542e84|R]P[0]tune[3,-1]key[30]q[26,0/69]bit[400]rc[1]
       Res[640x360,0/0,0/0]fps[15.0]tb[1/15]vfr[0]scc[0]aq[0/0.5,0]
       svc[0]fmt[1]th[0,1,64]ltr[0]mc[0,100]rc2[0,0,0,0.00,...]
```

`Res[宽x高,...]`、`fps[...]`、`key[...]`、`q[...]`、`bit[...]` 都能直接读，
改一个字段看这里变不变，比猜结构体快得多。

### 2.5 打开编码器的最小可用配置

```c
void *p = t265_param_alloc();
t265_param_default(p);
*(int*)((char*)p + 0)  = 640;   // width
*(int*)((char*)p + 4)  = 360;   // height
*(int*)((char*)p + 8)  = 15;    // fpsNum
*(int*)((char*)p + 12) = 1;     // fpsDenom
t265_param_parse(p, "bitrate", "400");
t265_param_parse(p, "keyint", "30");
t265_param_parse(p, "qp", "26");
t265_param_parse(p, "annexb", "1");
t265_param_parse(p, "repeat-headers", "1");
t265_param_parse(p, "bframes", "0");
t265_param_parse(p, "rc-lookahead", "0");
t265_param_parse(p, "frame-threads", "1");

int err = 0;
void *enc = t265_encoder_open(p, &err);   // 成功返回非 NULL
```

**实测可以打开成功**，自检行显示 `Res[640x360] fps[15.0] key[30] q[26] bit[400]`。

## 3. 卡住的地方

`t265_encoder_encode` 需要 `x265_picture` 结构体。按标准 x265 布局构造
（`planes[3]` 在偏移 0/8/16，其余填 0）会**段错误** —— 说明魔改版的结构体
布局不同。

没有 `t265_picture_alloc` 之类的辅助函数可用，只能靠逆向确定布局。

## 4. 下一步：IDA

需要确认：

1. `x265_picture` 的字段顺序与大小（尤其 `planes` / `stride` / `pts` / `bitDepth`）
2. `t265_encoder_encode` 的签名（是否多了参数）
3. 是否需要配套调 `t265_encoder_notice_received_frames`（魔改新增的参考帧反馈）
4. 编码出来的码流是否真能被对端解（最终验证）

定位方法：`t265_encoder_encode` 在 `.so` 里的地址可以从导出表直接拿到
（`nm -D` 已有），IDA 里跟进去看它怎么读第二个参数即可。

## 5. Windows 的情况

`AVSDKPlugin.dll` **不导出符号**（Opus 那边就是靠日志字符串锚点 + 字节扫描
找入口的）。所以 Windows 上连函数地址都要先扫，结构体布局更是只能纯逆向。

如果最终要做 Windows，工作量大致是 Linux 的两倍以上。

## 6. 相关代码

- `nt_helper/src/call/avsdk.rs` —— Opus 的三平台加载方式（Linux/macOS 走导出表，
  Windows 走日志锚点扫描），`t265` 可以照抄这套结构
- `docs/develop/voice-call-20261023.md` §5.2 —— 音频编码器的同款问题
