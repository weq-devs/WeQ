//! 线程安全的守护进程运行时状态：HTTP 服务的句柄与参数。
//!
//! 放进 `Arc<Mutex<>>` 由控制管道与 HTTP 任务共享；所有「改状态」的操作
//! 都收敛到这个模块的方法里，pipe/httpd 两侧只读字段。

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch, Mutex};
use tokio::task::JoinHandle;

/// `http_start` 的参数（WeQ 每次开启都重新下发，不持久化）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpConfig {
    /// 监听端口（固定绑 127.0.0.1）。
    pub port: u16,
    /// 静态文件根目录（绝对路径）。
    pub docroot: String,
}

/// 守护进程内共享的可变状态。
pub struct DaemonState {
    /// 当前 HTTP 服务参数；`None` = 未开启。
    http: Option<HttpConfig>,
    /// HTTP 服务任务句柄；与 `http` 同生命周期（同 Some / 同 None）。
    http_task: Option<JoinHandle<()>>,
    /// 关停信号发送端：持活让 httpd 的 `changed()` 不会误判「通道关闭」。
    http_shutdown_tx: Option<watch::Sender<bool>>,
    /// HTTP 任务结束通知：关停方等它确认端口已释放。
    http_done: Option<mpsc::Receiver<()>>,
}

pub type SharedState = Arc<Mutex<DaemonState>>;

impl DaemonState {
    pub fn new() -> SharedState {
        Arc::new(Mutex::new(DaemonState {
            http: None,
            http_task: None,
            http_shutdown_tx: None,
            http_done: None,
        }))
    }

    /// 当前 HTTP 参数快照（`http_status` 用）。
    pub async fn http_config(state: &SharedState) -> Option<HttpConfig> {
        state.lock().await.http.clone()
    }

    /// 起动（或替换）HTTP 服务。同参数重复调用是幂等成功。
    pub async fn http_start(state: &SharedState, cfg: HttpConfig) -> Result<(), String> {
        let mut st = state.lock().await;
        if let Some(cur) = &st.http {
            if *cur == cfg {
                return Ok(()); // 幂等
            }
            // 参数变化：先关旧的再起新的（端口或 docroot 迁移）。
            stop_locked(&mut st).await;
        }
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (done_tx, done_rx) = mpsc::channel(1);
        let task_cfg = cfg.clone();
        let handle = tokio::spawn(async move {
            crate::httpd::run(task_cfg, shutdown_rx, done_tx).await;
        });
        // 留一点时间让 bind 失败浮出水面（bind 错误会终结任务）。
        tokio::time::sleep(Duration::from_millis(150)).await;
        if handle.is_finished() {
            // 任务已退出 ⇒ bind 失败；句柄 await 只是把日志落完。
            let _ = handle.await;
            return Err(format!(
                "http bind 127.0.0.1:{} failed (port busy or permission denied)",
                cfg.port
            ));
        }
        st.http = Some(cfg.clone());
        st.http_task = Some(handle);
        st.http_shutdown_tx = Some(shutdown_tx);
        st.http_done = Some(done_rx);
        crate::logger::info(&format!(
            "http started: port={} docroot={}",
            cfg.port, cfg.docroot
        ));
        Ok(())
    }

    /// 关停 HTTP 服务（幂等；本来就关着也返回 Ok）。
    pub async fn http_stop(state: &SharedState) {
        let mut st = state.lock().await;
        stop_locked(&mut st).await;
    }
}

/// 锁内关停。持锁方调用；等待任务退出最多 3 秒。
async fn stop_locked(st: &mut DaemonState) {
    let Some(cfg) = st.http.take() else {
        return;
    };
    if let Some(tx) = st.http_shutdown_tx.take() {
        tx.send_if_modified(|v| {
            if *v {
                false
            } else {
                *v = true;
                true
            }
        });
    }
    let task = st.http_task.take();
    let done = st.http_done.take();
    if let (Some(task), Some(mut done)) = (task, done) {
        // 宽限期：超时则 abort（httpd 收到 shutdown 后 ≤1 秒自行退出）。
        let _ = tokio::time::timeout(Duration::from_secs(3), done.recv()).await;
        task.abort();
        let _ = task.await;
    }
    crate::logger::info(&format!(
        "http stopped: port={} docroot={}",
        cfg.port, cfg.docroot
    ));
}
