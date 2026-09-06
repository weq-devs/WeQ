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
