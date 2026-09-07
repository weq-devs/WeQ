//! 控制管道协议：JSON + 4 字节小端长度前缀的分帧。
//!
//! 请求 / 响应都是一行 JSON；命令字全部 `snake_case`（serde rename）。新增
//! 功能（例如「监听 GitHub release」）= 新增一个 `Request` 变体 + 守护进程
//! 里的处理分支，管道与分帧不变。
//!
//! 约束：
//!   - 单帧上限 1 MiB（防手滑 / 防恶意本地进程）；
//!   - `docroot` 等路径参数一律绝对路径，由 WeQ 侧保证存在。

use serde::{Deserialize, Serialize};

/// 默认管道名。Windows 是 named pipe 名，unix 是 `$TMPDIR` 下的 socket 文件名。
pub const DEFAULT_PIPE_NAME: &str = "weq-daemon";

/// 单帧 JSON 上限。
pub const MAX_FRAME: u32 = 1024 * 1024;

/// GitHub release 轮询配置（`release_watch_start` 下发）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseWatchConfig {
    /// GitHub API 根（默认官方；测试可指向本地 mock server）。
    pub api_base: String,
    /// 仓库 `owner/name`。
    pub repo: String,
    /// 轮询间隔（秒）。
    pub interval_secs: u64,
    /// 当前已安装版本（`1.2.3`，不带 `v` 前缀；空串 = 未知，首个 release 即提醒）。
    pub current_version: String,
}

/// `release_watch_status` 的载荷（请求与响应共用同一结构）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReleaseWatchInfo {
    /// 轮询任务在跑。
    pub watching: bool,
    pub repo: Option<String>,
    pub interval_secs: Option<u64>,
    /// 当前已安装版本（WeQ 下发的）。
    pub current_version: Option<String>,
    /// 最近一次成功轮询到的最新版本。
    pub latest_seen: Option<String>,
    /// 未确认的新版本（GUI 弹窗 / 推文用）。
    pub pending: Option<String>,
    /// 最近一次轮询结果（网络错误摘要；成功一轮后清空）。
    pub last_error: Option<String>,
}

/// 自启动注册记忆（`autostart_set` 下发；守护进程用它执行注册/卸载并落盘）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutostartMemory {
    /// true = 注册开机自启；false = 撤销注册。
    pub enabled: bool,
    /// 要拉起的 WeQ GUI 可执行文件（绝对路径）。
    pub gui_exe: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Request {
    /// 探活。返回 [`Response::Pong`]。
    Ping,
    /// 开启（或按新参数重启）HTTP 服务。
    HttpStart { port: u16, docroot: String },
    /// 关闭 HTTP 服务（守护进程本体继续活着）。
    HttpStop,
    /// 查询 HTTP 服务状态。
    HttpStatus,
    /// 开启（或按新参数重启）GitHub release 轮询。
    ReleaseWatchStart(ReleaseWatchConfig),
    /// 关闭 release 轮询。
    ReleaseWatchStop,
    /// 查询 release 轮询状态（含未确认的新版本）。
    ReleaseWatchStatus,
    /// 用户已确认某版本（ GUI 弹窗已展示 / 已同步推文），守护进程停止为其置位。
    ReleaseAck { version: String },
    /// 注册 / 撤销 WeQ GUI 的开机自启（写注册表 / plist / systemd unit，并落记忆）。
    AutostartSet(AutostartMemory),
    /// 仅按记忆里的开关执行注册或卸载（启动时 WeQ 拉起守护进程后的对账）。
    AutostartSync,
    /// 查询自启动注册状态。
    AutostartStatus,
    /// 优雅退出守护进程（连接会被服务端直接关闭，客户端读 EOF 即成功）。
    Stop,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "res", rename_all = "snake_case")]
pub enum Response {
    Pong {
        version: String,
        http_running: bool,
    },
    Started {
        port: u16,
    },
    Stopped,
    HttpStatus {
        running: bool,
        port: Option<u16>,
        docroot: Option<String>,
    },
    ReleaseWatchStatus(ReleaseWatchInfo),
    /// 自启动注册已完成（`autostart_set` / `autostart_sync` 的答复）。
    AutostartApplied {
        enabled: bool,
    },
    /// 自启动注册状态（`autostart_status`）。
    AutostartStatus {
        /// 守护进程落盘的开关记忆（WeQ 上次设置的意图）。
        enabled: bool,
        /// 平台注册实际在位（任务 / plist / unit 真的装着）。
        registered: bool,
    },
    Error {
        message: String,
    },
}

/// 编码一帧：4 字节小端长度 + JSON 字节。
pub fn encode_frame(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(value).map_err(|e| format!("serialize: {e}"))?;
    let len = u32::try_from(json.len()).map_err(|_| "frame too large".to_string())?;
    if json.len() > MAX_FRAME as usize {
        return Err("frame too large".to_string());
    }
    let mut out = Vec::with_capacity(4 + json.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&json);
    Ok(out)
}

/// 从缓冲区解码一帧；返回 (响应, 消耗字节数)。
/// 缓冲区不足一帧时返回 `Ok(None)`，调用方继续读。
pub fn decode_frame(buf: &[u8]) -> Result<Option<(Response, usize)>, String> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&buf[..4]);
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > MAX_FRAME as usize {
        return Err(format!("frame length {len} exceeds limit {MAX_FRAME}"));
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let resp: Response =
        serde_json::from_slice(&buf[4..4 + len]).map_err(|e| format!("deserialize: {e}"))?;
    Ok(Some((resp, 4 + len)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all_variants() {
        let reqs = [
            Request::Ping,
            Request::HttpStart {
                port: 17690,
                docroot: "/tmp/x".into(),
            },
            Request::HttpStop,
            Request::HttpStatus,
            Request::ReleaseWatchStart(ReleaseWatchConfig {
                api_base: "https://api.github.com".into(),
                repo: "H3CoF6/WeQ".into(),
                interval_secs: 3600,
                current_version: "0.4.6".into(),
            }),
            Request::ReleaseWatchStop,
            Request::ReleaseWatchStatus,
            Request::ReleaseAck {
                version: "0.5.0".into(),
            },
            Request::AutostartSet(AutostartMemory {
                enabled: true,
                gui_exe: "/app/weQ".into(),
            }),
            Request::AutostartSync,
            Request::AutostartStatus,
            Request::Stop,
        ];
        for req in reqs {
            let json = serde_json::to_string(&req).unwrap();
            // 命令字都是 snake_case tag
            assert!(json.starts_with("{\"cmd\":\""), "tag missing in {json}");
            assert!(!json.contains("\"HttpStart\""), "camelCase leaked: {json}");
        }
        let resps = [
            Response::Pong {
                version: "0.1.0".into(),
                http_running: false,
            },
            Response::Started { port: 80 },
            Response::Stopped,
            Response::HttpStatus {
                running: true,
                port: Some(1),
                docroot: Some("/".into()),
            },
            Response::ReleaseWatchStatus(ReleaseWatchInfo {
                watching: true,
                repo: Some("H3CoF6/WeQ".into()),
                interval_secs: Some(3600),
                current_version: Some("0.4.6".into()),
                latest_seen: Some("0.5.0".into()),
                pending: Some("0.5.0".into()),
                last_error: None,
            }),
            Response::AutostartApplied { enabled: true },
            Response::AutostartStatus {
                enabled: true,
                registered: true,
            },
            Response::Error {
                message: "boom".into(),
            },
        ];
        for resp in resps {
            let json = serde_json::to_string(&resp).unwrap();
            assert!(json.starts_with("{\"res\":\""), "tag missing in {json}");
        }
    }

    #[test]
    fn new_command_json_shapes() {
        // 新命令的线上 JSON 形状固定下来：GUI 侧 TS 镜像按这些字段解析。
        assert_eq!(
            serde_json::to_string(&Request::ReleaseWatchStart(ReleaseWatchConfig {
                api_base: "https://api.github.com".into(),
                repo: "H3CoF6/WeQ".into(),
                interval_secs: 3600,
                current_version: String::new(),
            }))
            .unwrap(),
            r#"{"cmd":"release_watch_start","api_base":"https://api.github.com","repo":"H3CoF6/WeQ","interval_secs":3600,"current_version":""}"#
        );
        assert_eq!(
            serde_json::to_string(&Request::AutostartSet(AutostartMemory {
                enabled: false,
                gui_exe: "/x/y.exe".into(),
            }))
            .unwrap(),
            r#"{"cmd":"autostart_set","enabled":false,"gui_exe":"/x/y.exe"}"#
        );
    }

    #[test]
    fn frame_roundtrip() {
        let resp = Response::Started { port: 17690 };
        let bytes = encode_frame(&resp).unwrap();
        assert_eq!(&bytes[..4], &(bytes.len() as u32 - 4).to_le_bytes());
        let (decoded, used) = decode_frame(&bytes).unwrap().unwrap();
        assert_eq!(decoded, resp);
        assert_eq!(used, bytes.len());
    }

    #[test]
    fn partial_frame_yields_none() {
        let resp = Response::Stopped;
        let bytes = encode_frame(&resp).unwrap();
        assert!(decode_frame(&bytes[..2]).unwrap().is_none());
        assert!(decode_frame(&bytes[..6]).unwrap().is_none());
        let (decoded, used) = decode_frame(&bytes).unwrap().unwrap();
        assert_eq!(decoded, resp);
        assert_eq!(used, bytes.len());
    }

    #[test]
    fn oversized_frame_rejected() {
        let bogus: Vec<u8> = (MAX_FRAME + 1).to_le_bytes().to_vec();
        let err = decode_frame(&bogus).unwrap_err();
        assert!(err.contains("exceeds limit"));
    }

    #[test]
    fn http_start_json_shape() {
        let json = serde_json::to_string(&Request::HttpStart {
            port: 17690,
            docroot: "/tmp/docroot".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"cmd":"http_start","port":17690,"docroot":"/tmp/docroot"}"#
        );
    }
}
