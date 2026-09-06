//! `http_start` 记忆：把最近一次成功的 HTTP 配置落盘，开机自启后自主恢复。
//!
//! 「记忆」只属于守护进程自己，不读 WeQ 的任何配置：
//!   - `http_start` 成功 → 覆写状态文件
//!   - `http_stop`       → 删状态文件（显式关闭 = 重启后保持关闭）
//!   - `stop`（进程退出）→ **保留**。下次开机自启后按记忆恢复 HTTP；
//!     「进程级停止」不是「配置变更」，重启后服务该回来还得回来。
//!
//! 路径（按管道名区分，多实例互不干扰）：
//!   win:   `%LOCALAPPDATA%\weq-daemon\<pipe>.json`
//!   mac:   `~/Library/Application Support/weq-daemon/<pipe>.json`
//!   linux: `$XDG_STATE_HOME/weq-daemon/<pipe>.json`（默认 `~/.local/state/`）
//!
//! 恢复时机与容错（`restore_on_boot`，serve 启动时调用一次）：
//!   - 文件存在且 docroot 仍是有效目录 → 重新 `http_start`
//!   - docroot 已不存在 → 保留文件、不启动（等 WeQ 重新下发）
//!   - 端口被占 / bind 失败 → 只记日志，管道照常活着，WeQ 随时可重下发
//!   - 文件损坏 / 字段非法 → 视为没有，直接删掉（坏记忆不如无记忆）
//!
//! 实现注记：核心逻辑全部是「接收目录参数」的 `*_in/_from/_to` 纯函数，
//! 公开接口只负责解析平台状态目录后转发 —— 这样单测可以直接喂临时目录，
//! 不需要改进程级环境变量（并行测试下 `set_var` 是数据竞争）。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::state::{DaemonState, HttpConfig, SharedState};

/// 状态文件内容。`version` 预留未来字段演进。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedHttp {
    version: u32,
    port: u16,
    docroot: String,
}

const STATE_VERSION: u32 = 1;

/// 状态目录（不含文件名）。
fn state_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")?;
        return Some(PathBuf::from(local).join("weq-daemon"));
    }
    if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME")?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("weq-daemon"),
        );
    }
    // linux / 其它 unix：XDG state
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("state"))
        })?;
    Some(base.join("weq-daemon"))
}

/// 目录内状态文件的完整路径。
fn state_file_in(dir: &Path, pipe_name: &str) -> PathBuf {
    dir.join(format!("{pipe_name}.json"))
}

/// 读取已持久化的配置；无效（损坏 / 版本不符）时删文件并返回 None。
/// 从指定目录读。
pub fn load_from(dir: &Path, pipe_name: &str) -> Option<PersistedHttp> {
    let path = state_file_in(dir, pipe_name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return None, // 不存在 = 正常情况
    };
    match serde_json::from_str::<PersistedHttp>(&raw) {
        Ok(p) if p.version == STATE_VERSION && !p.docroot.is_empty() => Some(p),
        _ => {
            crate::logger::warn(&format!("invalid state file {} — removing", path.display()));
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// 覆写状态文件（原子性靠「写临时文件 + rename」保证，写一半崩溃不留坏文件）。
pub fn save(pipe_name: &str, cfg: &HttpConfig) {
    let Some(dir) = state_dir() else {
        crate::logger::warn("no state dir resolvable — http_start will not survive reboot");
        return;
    };
    save_to(&dir, pipe_name, cfg);
}

/// `save` 的可注入版本：写到指定目录。
pub fn save_to(dir: &Path, pipe_name: &str, cfg: &HttpConfig) {
    if let Err(err) = std::fs::create_dir_all(dir) {
        crate::logger::warn(&format!("create state dir {} failed: {err}", dir.display()));
        return;
    }
    let path = state_file_in(dir, pipe_name);
    let tmp = dir.join(format!("{pipe_name}.json.tmp"));
    let payload = PersistedHttp {
        version: STATE_VERSION,
        port: cfg.port,
        docroot: cfg.docroot.clone(),
    };
    let json = match serde_json::to_string_pretty(&payload) {
        Ok(json) => json,
        Err(err) => {
            crate::logger::warn(&format!("serialize state: {err}"));
            return;
        }
    };
    if let Err(err) = std::fs::write(&tmp, json) {
        crate::logger::warn(&format!("write state tmp failed: {err}"));
        return;
    }
    if let Err(err) = std::fs::rename(&tmp, &path) {
        // Windows 上 rename 覆盖已存在文件偶发受限，退回直接写。
        let _ = std::fs::remove_file(&path);
        if let Err(err2) = std::fs::rename(&tmp, &path) {
            crate::logger::warn(&format!("persist state failed: {err} / {err2}"));
            return;
        }
    }
    crate::logger::info(&format!(
        "state saved: port={} docroot={}",
        cfg.port, cfg.docroot
    ));
}

/// 删除状态文件（`http_stop` 时调用）。
pub fn clear(pipe_name: &str) {
    let Some(dir) = state_dir() else { return };
    clear_in(&dir, pipe_name);
}

/// `clear` 的可注入版本：删指定目录里的状态文件。
pub fn clear_in(dir: &Path, pipe_name: &str) {
    let path = state_file_in(dir, pipe_name);
    if std::fs::remove_file(&path).is_ok() {
        crate::logger::info("state cleared (http stopped)");
    }
    // 删失败 = 本来就没有，正常。
}

/// serve 启动时按记忆恢复 HTTP。所有失败都只记日志 —— 恢复永远不能阻塞
/// 控制管道就绪（WeQ 随时可以重新下发覆盖）。
pub async fn restore_on_boot(state: &SharedState, pipe_name: &str) {
    let Some(dir) = state_dir() else { return };
    restore_from(state, &dir, pipe_name).await;
}

/// `restore_on_boot` 的可注入版本：从指定目录恢复。
pub async fn restore_from(state: &SharedState, dir: &Path, pipe_name: &str) {
    let Some(persisted) = load_from(dir, pipe_name) else {
        return;
    };
    if !Path::new(&persisted.docroot).is_dir() {
        crate::logger::warn(&format!(
            "restored http skipped: docroot gone ({}), waiting for WeQ to re-issue",
            persisted.docroot
        ));
        return; // 保留文件：目录可能只是还没挂载（网络盘等）
    }
    let cfg = HttpConfig {
        port: persisted.port,
        docroot: persisted.docroot,
    };
    match DaemonState::http_start(state, cfg).await {
        Ok(()) => crate::logger::info("http restored from last session's memory"),
        Err(err) => crate::logger::warn(&format!("http restore failed (pipe still up): {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试独立的临时目录；不碰进程级环境变量（并行测试下是数据竞争）。
    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "weq-daemon-persist-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = temp_dir("roundtrip");
        let cfg = HttpConfig {
            port: 17690,
            docroot: "/tmp/x".into(),
        };
        save_to(&dir, "weq-daemon-test", &cfg);
        let loaded = load_from(&dir, "weq-daemon-test").unwrap();
        assert_eq!(loaded.port, 17690);
        assert_eq!(loaded.docroot, "/tmp/x");
        assert_eq!(loaded.version, STATE_VERSION);

        clear_in(&dir, "weq-daemon-test");
        assert!(load_from(&dir, "weq-daemon-test").is_none());
        assert!(
            !state_file_in(&dir, "weq-daemon-test").exists(),
            "cleared file must be gone"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_overwrites_previous() {
        let dir = temp_dir("overwrite");
        save_to(
            &dir,
            "weq-daemon-test",
            &HttpConfig {
                port: 1111,
                docroot: "/tmp/a".into(),
            },
        );
        save_to(
            &dir,
            "weq-daemon-test",
            &HttpConfig {
                port: 2222,
                docroot: "/tmp/b".into(),
            },
        );
        let loaded = load_from(&dir, "weq-daemon-test").unwrap();
        assert_eq!(loaded.port, 2222, "last successful http_start must win");
        assert_eq!(loaded.docroot, "/tmp/b");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_removed() {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let bad = state_file_in(&dir, "weq-daemon-test");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(load_from(&dir, "weq-daemon-test").is_none());
        assert!(!bad.exists(), "corrupt file must be removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn version_mismatch_is_invalid() {
        let dir = temp_dir("version");
        std::fs::create_dir_all(&dir).unwrap();
        let path = state_file_in(&dir, "weq-daemon-test");
        std::fs::write(&path, r#"{"version":99,"port":1,"docroot":"/tmp"}"#).unwrap();
        assert!(load_from(&dir, "weq-daemon-test").is_none());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_is_none() {
        let dir = temp_dir("missing");
        assert!(load_from(&dir, "weq-daemon-test").is_none());
    }

    #[test]
    fn default_pipe_name_unchanged() {
        // 保护默认管道名：状态文件按管道名区分，改名会丢用户记忆。
        assert_eq!(crate::pipe::current_pipe_name(), "weq-daemon");
    }
}
