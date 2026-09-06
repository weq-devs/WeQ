//! 控制管道：Windows named pipe / Unix domain socket 的统一封装。
//!
//! 服务端：`run_control_loop` —— 接受连接、按协议分帧读请求、分发到
//! [`handle_request`]、写回响应。多客户端并发（WeQ 可能同时开多个连接）。
//!
//! 客户端：`call_once` —— 连接、发一帧、读一帧（`Stop` 命令读 EOF 即成功）。
//!
//! 平台差异全部隔离在本模块底部的 `imp` 子模块：

use tokio::io::{AsyncRead, AsyncWrite};

use crate::protocol::{decode_frame, encode_frame, Request, Response, MAX_FRAME};
use crate::state::{DaemonState, SharedState};

/// 当前管道名。`handle_request` 的持久化调用需要它；`run_control_loop`
/// 进入时写入。单线程赋值 + 之后只读，无竞态。
static CURRENT_PIPE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub(crate) fn current_pipe_name() -> &'static str {
    CURRENT_PIPE
        .get()
        .map(|s| s.as_str())
        .unwrap_or(crate::protocol::DEFAULT_PIPE_NAME)
}

// ---------- server ----------

/// 守护进程控制循环：监听管道，逐连接处理，直到进程退出。
pub async fn run_control_loop(pipe_name: &str) -> Result<(), String> {
    let _ = CURRENT_PIPE.set(pipe_name.to_string());
    let state = DaemonState::new();
    // 按记忆恢复上次的 HTTP 服务（如有）。失败只记日志 —— 管道必须照常就绪。
    crate::persist::restore_on_boot(&state, pipe_name).await;
    imp::serve_forever(pipe_name, state).await
}

/// 单客户端处理：读一帧 → 分发 → 写回 → 关连接。
async fn serve_client<S>(mut stream: S, state: SharedState) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // 读满一帧（4 字节小端长度 + JSON）。客户端一次只发一个请求。
    let mut len_bytes = [0u8; 4];
    stream
        .read_exact(&mut len_bytes)
        .await
        .map_err(|e| format!("read length: {e}"))?;
    let len = u32::from_le_bytes(len_bytes) as usize;
    if len > MAX_FRAME as usize {
        return Err(format!("frame too large: {len}"));
    }
    let mut json = vec![0u8; len];
    stream
        .read_exact(&mut json)
        .await
        .map_err(|e| format!("read body: {e}"))?;
    let req: Request = serde_json::from_slice(&json).map_err(|e| format!("parse: {e}"))?;

    let is_stop = matches!(req, Request::Stop);
    let resp = handle_request(req, &state).await;
    if !is_stop {
        let frame = encode_frame(&resp)?;
        stream
            .write_all(&frame)
            .await
            .map_err(|e| format!("write: {e}"))?;
        stream.flush().await.ok();
    }
    // Stop：不回帧，直接落半关让客户端读到 EOF（客户端据此判定成功）。
    let _ = stream.shutdown().await;
    Ok(())
}

/// 命令分发。所有业务逻辑只有这几行 —— 新命令 = 新 `Request` 变体 + 这里一个分支。
async fn handle_request(req: Request, state: &SharedState) -> Response {
    match req {
        Request::Ping => {
            let running = DaemonState::http_config(state).await.is_some();
            Response::Pong {
                version: env!("CARGO_PKG_VERSION").to_string(),
                http_running: running,
            }
        }
        Request::HttpStart { port, docroot } => {
            // 基础校验：docroot 必须存在（内容不校验 —— WeQ 发布完才开服务）。
            if !std::path::Path::new(&docroot).is_dir() {
                return Response::Error {
                    message: format!("docroot is not a directory: {docroot}"),
                };
            }
            match DaemonState::http_start(state, crate::state::HttpConfig { port, docroot }).await {
                Ok(()) => {
                    let cfg = DaemonState::http_config(state).await;
                    // 成功才记忆：重启后按这份配置自主恢复。
                    if let Some(cfg) = &cfg {
                        crate::persist::save(current_pipe_name(), cfg);
                    }
                    Response::Started {
                        port: cfg.map(|c| c.port).unwrap_or(port),
                    }
                }
                Err(message) => Response::Error { message },
            }
        }
        Request::HttpStop => {
            DaemonState::http_stop(state).await;
            // 显式关闭 = 撤销记忆：重启后保持关闭，直到 WeQ 再次下发。
            crate::persist::clear(current_pipe_name());
            Response::Stopped
        }
        Request::HttpStatus => {
            let cfg = DaemonState::http_config(state).await;
            Response::HttpStatus {
                running: cfg.is_some(),
                port: cfg.as_ref().map(|c| c.port),
                docroot: cfg.as_ref().map(|c| c.docroot.clone()),
            }
        }
        Request::Stop => {
            DaemonState::http_stop(state).await;
            crate::logger::info("stop requested via control pipe — exiting");
            // HTTP 已关停；直接退出进程（控制循环无法从 handler 里优雅返回）。
            std::process::exit(0);
        }
    }
}

// ---------- client ----------

/// 一次性客户端调用：连管道 → 发请求 → 读响应。
/// `Stop` 命令服务端不回帧（直接断开），读到 EOF 时返回 `Response::Stopped`。
pub async fn call_once(pipe_name: &str, req: &Request) -> Result<Response, String> {
    let mut stream = imp::connect(pipe_name)
        .await
        .map_err(|e| format!("connect control pipe: {e} (daemon not running?)"))?;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let frame = encode_frame(req)?;
    stream
        .write_all(&frame)
        .await
        .map_err(|e| format!("send: {e}"))?;
    stream.flush().await.ok();

    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("recv: {e}"))?;
        if n == 0 {
            // EOF：服务端没回帧。Stop 命令的预期行为；其他命令视为协议错误。
            if matches!(req, Request::Stop) {
                return Ok(Response::Stopped);
            }
            return Err("daemon closed connection without a response".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);
        match decode_frame(&buf) {
            Ok(Some((resp, _))) => return Ok(resp),
            Ok(None) => continue,
            Err(err) => return Err(err),
        }
    }
}

// ---------- platform implementations ----------

#[cfg(windows)]
mod imp {
    use super::{serve_client, SharedState};
    use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

    /// Windows named pipe 的完整路径。
    pub fn full_path(pipe_name: &str) -> String {
        format!(r"\\.\pipe\{pipe_name}")
    }

    pub async fn serve_forever(pipe_name: &str, state: SharedState) -> Result<(), String> {
        let path = full_path(pipe_name);
        // 首个实例独占管道名，重复 serve 会立刻报错（单实例的另一道保险）。
        let mut server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path)
            .map_err(|e| format!("create pipe {path}: {e}"))?;
        crate::logger::info(&format!("control pipe ready: {path}"));

        loop {
            // connect().await = 等一个客户端连上；连上后这个实例就是连接本体。
            server
                .connect()
                .await
                .map_err(|e| format!("pipe connect: {e}"))?;

            // 立刻为下一个客户端创建新的 server 实例（Windows named pipe 惯例）。
            let conn = server;
            server = match ServerOptions::new().create(&path) {
                Ok(s) => s,
                Err(err) => {
                    crate::logger::warn(&format!("re-create pipe failed: {err}"));
                    // 管道名被占（理论上不会：first_pipe_instance 已持有）；
                    // 休眠后重试，避免忙转。
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    match ServerOptions::new().create(&path) {
                        Ok(s) => s,
                        Err(e2) => return Err(format!("re-create pipe: {e2}")),
                    }
                }
            };

            let state = state.clone();
            tokio::spawn(async move {
                if let Err(err) = serve_client(conn, state).await {
                    crate::logger::warn(&format!("client error: {err}"));
                }
            });
        }
    }

    pub async fn connect(
        pipe_name: &str,
    ) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
        ClientOptions::new().open(full_path(pipe_name))
    }
}

#[cfg(unix)]
mod imp {
    use super::{serve_client, SharedState};
    use std::path::PathBuf;
    use tokio::net::{UnixListener, UnixStream};

    pub fn socket_path(pipe_name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{pipe_name}.sock"))
    }

    pub async fn serve_forever(pipe_name: &str, state: SharedState) -> Result<(), String> {
        let path = socket_path(pipe_name);
        // 清掉上次进程被 kill -9 留下的残留 socket 文件。
        let _ = std::fs::remove_file(&path);
        let listener =
            UnixListener::bind(&path).map_err(|e| format!("bind {}: {e}", path.display()))?;
        crate::logger::info(&format!("control pipe ready: {}", path.display()));

        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(err) = serve_client(stream, state).await {
                            crate::logger::warn(&format!("client error: {err}"));
                        }
                    });
                }
                Err(err) => {
                    crate::logger::warn(&format!("accept failed: {err}"));
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    pub async fn connect(pipe_name: &str) -> std::io::Result<UnixStream> {
        UnixStream::connect(socket_path(pipe_name)).await
    }
}
