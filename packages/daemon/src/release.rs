//! GitHub release 轮询（按约定：Rust 实现，普通轮询，不上 webhooks）。
//!
//! 设计与守护进程的其它部分同构：
//!   - WeQ 通过 `release_watch_start` 下发 api_base / repo / interval / 当前版本，
//!     守护进程起一个后台 tokio 任务按间隔 `GET /repos/<repo>/releases/latest`；
//!   - 「latest」指 GitHub 的最新正式版（该接口本就排除 prerelease/draft），
//!     版本号统一剥掉 `v` 前缀再比较；
//!   - 比 current_version 新 ⇒ 置 `pending`：设置页轮询 `release_watch_status`
//!     读它弹系统通知，GUI 确认后发 `release_ack` 清除并把 current_version
//!     推进到该版本（下一轮不再重复置位）；
//!   - pending / 配置落进状态文件（与 httpd 记忆同目录），守护进程重启后恢复
//!     —— WeQ 没来得及 ack 就重启，也还提醒得到（重复一次好过漏一次）；
//!   - 网络失败只记 `last_error` 等下一轮，任务永不退出；换配置 = 停旧任务起新任务。
//!
//! GitHub 在大陆直连不稳是已知问题：轮询失败会体现在 `last_error` 里，
//! 设置页据此提示；WeQ 侧可以为 api_base 传镜像地址（协议不限定官方域名）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::protocol::ReleaseWatchConfig;

/// 状态文件内容。`version` 预留字段演进。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PersistedRelease {
    version: u32,
    /// 已发现但 GUI 未 ack 的版本。
    pending: Option<String>,
    /// WeQ 下发的轮询配置（恢复后照它重新起任务）。
    config: Option<ReleaseWatchConfig>,
}

const STATE_VERSION: u32 = 1;

/// 一次 `release_watch_status` 的快照（协议字段之外的内部状态）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReleaseStatus {
    /// 已配置（收到过 `release_watch_start`）且任务在跑。
    pub watching: bool,
    pub config: Option<ReleaseWatchConfig>,
    /// 最近一次成功轮询看到的最新版本。
    pub latest_seen: Option<String>,
    /// 比 current 新、等 GUI ack 的版本。
    pub pending: Option<String>,
    /// 最近一次轮询失败原因（成功一轮后清空）。
    pub last_error: Option<String>,
}

struct WatcherInner {
    status: ReleaseStatus,
    task: Option<JoinHandle<()>>,
}

/// 守护进程里共享的 release 监控句柄。
pub struct ReleaseWatcher {
    inner: Arc<Mutex<WatcherInner>>,
    /// 状态文件目录（`persist::release_state_dir()`；解析失败 = 只在内存）。
    state_dir: Option<PathBuf>,
    pipe_name: String,
}

impl ReleaseWatcher {
    pub fn new(pipe_name: &str) -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatcherInner {
                status: ReleaseStatus::default(),
                task: None,
            })),
            state_dir: crate::persist::release_state_dir(),
            pipe_name: pipe_name.to_string(),
        }
    }

    /// 当前状态快照（`release_watch_status` 用）。
    pub async fn status(&self) -> ReleaseStatus {
        self.inner.lock().await.status.clone()
    }

    /// 开启（或按新参数重启）轮询。同参数重复调用 = 幂等重启，无副作用。
    pub async fn start(&self, cfg: ReleaseWatchConfig) {
        let mut w = self.inner.lock().await;
        if let Some(task) = w.task.take() {
            task.abort();
        }
        w.status.watching = true;
        w.status.config = Some(cfg.clone());
        w.status.last_error = None;
        w.task = Some(spawn_poller(
            Arc::clone(&self.inner),
            self.state_dir.clone(),
            self.pipe_name.clone(),
        ));
        drop(w);
        self.persist();
    }

    /// 停止轮询（`latest_seen` / `pending` 保留，落盘更新）。
    pub async fn stop(&self) {
        let mut w = self.inner.lock().await;
        if let Some(task) = w.task.take() {
            task.abort();
        }
        w.status.watching = false;
        w.status.config = None;
        drop(w);
        self.persist();
    }

    /// GUI 已处理该版本 → 清 pending、current_version 推进、落盘。
    pub async fn ack(&self, version: &str) {
        let mut w = self.inner.lock().await;
        if w.status.pending.as_deref() == Some(version) {
            w.status.pending = None;
        }
        if let Some(cfg) = w.status.config.as_mut() {
            cfg.current_version = version.to_string();
        }
        drop(w);
        self.persist();
    }

    /// serve 启动时从状态文件恢复 pending + 配置（失败只记日志，绝不阻塞管道）。
    pub async fn restore(&self) {
        let Some(dir) = &self.state_dir else { return };
        let raw = match std::fs::read_to_string(release_file_in(dir, &self.pipe_name)) {
            Ok(raw) => raw,
            Err(_) => return, // 不存在 = 正常
        };
        let Ok(p) = serde_json::from_str::<PersistedRelease>(&raw) else {
            crate::logger::warn("invalid release state file — removing");
            let _ = std::fs::remove_file(release_file_in(dir, &self.pipe_name));
            return;
        };
        if p.version != STATE_VERSION {
            crate::logger::warn("release state file version mismatch — dropping");
            let _ = std::fs::remove_file(release_file_in(dir, &self.pipe_name));
            return;
        }
        let mut w = self.inner.lock().await;
        w.status.pending = p.pending;
        w.status.latest_seen = w.status.pending.clone();
        if let Some(cfg) = p.config {
            w.status.watching = true;
            w.status.config = Some(cfg.clone());
            w.task = Some(spawn_poller(
                Arc::clone(&self.inner),
                self.state_dir.clone(),
                self.pipe_name.clone(),
            ));
        }
        drop(w);
        crate::logger::info("release watch restored from state file");
    }

    /// 原子落盘当前 pending / config（写临时文件 + rename，崩溃不留坏文件）。
    fn persist(&self) {
        let Some(dir) = &self.state_dir else { return };
        let file = release_file_in(dir, &self.pipe_name);
        let payload = {
            let w = &self.inner;
            // 同步上下文里只读一次状态；tokio Mutex 的 blocking_try_lock 在
            // 无竞争时可用，竞争时跳过本轮落盘（下一轮改动会再写）。
            let Ok(w) = w.try_lock() else { return };
            PersistedRelease {
                version: STATE_VERSION,
                pending: w.status.pending.clone(),
                config: w.status.config.clone(),
            }
        };
        persist_to(dir, &file, &payload);
    }
}

// ── 纯逻辑（可单测） ────────────────────────────────────────────────────────

/// 剥掉 `v` 前缀，按「数字段逐段比较、同段后缀字符串兜底」的宽松 semver。
/// `1.0` 视为 `1.0.0`（缺段 = 0）；无法解析的段按字符串比较。
pub fn is_newer(candidate: &str, current: &str) -> bool {
    fn norm(s: &str) -> Vec<(u64, String)> {
        let s = s.trim().trim_start_matches(['v', 'V']);
        s.split('.')
            .map(|seg| {
                let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                let num = digits.parse::<u64>().unwrap_or(0);
                let rest = seg[digits.len()..].to_string();
                (num, rest)
            })
            .collect()
    }
    let a = norm(candidate);
    let b = norm(current);
    if a.is_empty() && b.is_empty() {
        return false;
    }
    let len = a.len().max(b.len());
    for i in 0..len {
        let da = a.get(i).cloned().unwrap_or((0, String::new()));
        let db = b.get(i).cloned().unwrap_or((0, String::new()));
        if da != db {
            return da > db;
        }
    }
    false
}

/// 一次轮询要请求的 URL（注入 api_base 便于测试 / 镜像）。
pub fn latest_url(api_base: &str, repo: &str) -> String {
    format!(
        "{}/repos/{}/releases/latest",
        api_base.trim_end_matches('/'),
        repo.trim_matches('/')
    )
}

/// 从 GitHub API 的 JSON 响应里取 `tag_name`。
fn tag_name_from_json(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    v.get("tag_name")?.as_str().map(str::to_string)
}

/// 状态目录内 release 状态文件的完整路径（按管道名区分，可注入单测）。
pub fn release_file_in(dir: &Path, pipe_name: &str) -> PathBuf {
    dir.join(format!("{pipe_name}-release.json"))
}

/// 原子写状态文件（与 persist.rs 的 http 记忆同一姿势）。
fn persist_to(dir: &Path, file: &Path, payload: &PersistedRelease) {
    if let Err(err) = std::fs::create_dir_all(dir) {
        crate::logger::warn(&format!("create release state dir failed: {err}"));
        return;
    }
    let Ok(json) = serde_json::to_string_pretty(payload) else {
        return;
    };
    let tmp = dir.join(format!(
        "{}.tmp",
        file.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("release")
    ));
    if let Err(err) = std::fs::write(&tmp, json) {
        crate::logger::warn(&format!("write release state tmp failed: {err}"));
        return;
    }
    if let Err(err) = std::fs::rename(&tmp, file) {
        // Windows rename 覆盖已存在文件偶发受限，退回先删再 rename。
        let _ = std::fs::remove_file(file);
        if let Err(err2) = std::fs::rename(&tmp, file) {
            crate::logger::warn(&format!("persist release state failed: {err} / {err2}"));
        }
    }
}

/// 轮询任务：按配置间隔请求 latest release，发现新版本就置 pending 并落盘。
/// 任务自身永不退出（配置被移除时由 `stop`/`start` abort），网络失败等下一轮。
fn spawn_poller(
    inner: Arc<Mutex<WatcherInner>>,
    state_dir: Option<PathBuf>,
    pipe_name: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let http = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("weq-daemon/", env!("CARGO_PKG_VERSION")))
            .build();
        let mut first = true;
        loop {
            // 读当前配置与间隔（锁内快拷贝，绝不在持锁时做网络 IO）。
            let Some(cfg) = inner.lock().await.status.config.clone() else {
                return;
            };
            let interval = Duration::from_secs(cfg.interval_secs.max(60));
            // 首轮立即检查（启动时就有新版本也能马上提醒），之后按间隔轮。
            if first {
                first = false;
            } else {
                tokio::time::sleep(interval).await;
            }

            let url = latest_url(&cfg.api_base, &cfg.repo);
            match http.get(&url).call() {
                Ok(resp) => {
                    let mut body = String::new();
                    if resp.into_reader().read_to_string(&mut body).is_err() {
                        continue;
                    }
                    let Some(tag) = tag_name_from_json(&body) else {
                        continue;
                    };
                    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
                    let mut w = inner.lock().await;
                    w.status.latest_seen = Some(latest.clone());
                    w.status.last_error = None;
                    if is_newer(&latest, &cfg.current_version)
                        && w.status.pending.as_deref() != Some(latest.as_str())
                    {
                        w.status.pending = Some(latest);
                    }
                    // 持锁内把 pending/config 快照落盘（小文件，可接受）。
                    if let Some(dir) = &state_dir {
                        persist_to(
                            dir,
                            &release_file_in(dir, &pipe_name),
                            &PersistedRelease {
                                version: STATE_VERSION,
                                pending: w.status.pending.clone(),
                                config: w.status.config.clone(),
                            },
                        );
                    }
                }
                Err(err) => {
                    let mut w = inner.lock().await;
                    w.status.last_error = Some(err.to_string());
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(is_newer("0.5.0", "0.4.6"));
        assert!(is_newer("v0.5.0", "0.4.6"));
        assert!(is_newer("V0.5.0", "0.4.6"));
        assert!(is_newer("0.4.10", "0.4.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.4.6", "0.4.6"));
        assert!(!is_newer("0.4.5", "0.4.6"));
        assert!(!is_newer("", ""));
        assert!(is_newer("1.0.0-beta", "1.0.0")); // 同数值段，后缀 > 无后缀
    }

    #[test]
    fn url_shape() {
        assert_eq!(
            latest_url("https://api.github.com", "H3CoF6/WeQ"),
            "https://api.github.com/repos/H3CoF6/WeQ/releases/latest"
        );
        // 容忍多余斜杠 / 尾斜杠（WeQ 侧手抖不炸协议）。
        assert_eq!(
            latest_url("https://api.github.com/", "/H3CoF6/WeQ/"),
            "https://api.github.com/repos/H3CoF6/WeQ/releases/latest"
        );
    }

    #[test]
    fn parses_tag_name() {
        assert_eq!(
            tag_name_from_json(r#"{"tag_name":"v0.5.0","name":"x"}"#),
            Some("v0.5.0".to_string())
        );
        assert_eq!(tag_name_from_json("not json"), None);
        assert_eq!(tag_name_from_json("{}"), None);
    }

    #[test]
    fn release_file_lays_under_dir_by_pipe() {
        let dir = Path::new("/tmp/state");
        assert_eq!(
            release_file_in(dir, "weq-daemon"),
            PathBuf::from("/tmp/state/weq-daemon-release.json")
        );
    }

    #[test]
    fn persisted_roundtrip() {
        let dir =
            std::env::temp_dir().join(format!("weq-daemon-release-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let payload = PersistedRelease {
            version: STATE_VERSION,
            pending: Some("0.5.0".into()),
            config: Some(ReleaseWatchConfig {
                api_base: "https://api.github.com".into(),
                repo: "H3CoF6/WeQ".into(),
                interval_secs: 3600,
                current_version: "0.4.6".into(),
            }),
        };
        let file = release_file_in(&dir, "weq-daemon-test");
        persist_to(&dir, &file, &payload);
        let raw = std::fs::read_to_string(&file).unwrap();
        let parsed: PersistedRelease = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, payload);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
