//! WeQ GUI 的开机自启记忆 —— **GUI 不注册任何原生自启**。
//!
//! 设计（刻意收窄）：
//!   - 全机**唯一**的原生自启注册是守护进程自己（`autostart.rs`，`serve` 启动时
//!     幂等注册）；
//!   - WeQ GUI 永远不走原生自启：设置页的开关只是一条**记忆**
//!     （`<pipe>.gui.json`），开机后由守护进程 `serve` 启动时读记忆 spawn 出来；
//!   - 守护进程不在 = 没人拉起 GUI。这是有意的：GUI 自启这个能力随守护进程存在，
//!     没有第二套注册，也没有兜底。
//!
//! 为什么删掉了「GUI 也注册一份原生自启」：那等于把「开机该拉起谁」的知识复制
//! 到系统注册里，每多一个要被拉起的组件（web 包 / 未来 CLI 包托管的 MCP server）
//! 就得再维护一整套平台注册与生命周期。收口到守护进程后，新增组件只需要：管好
//! 自己的进程生命周期 + 在守护进程里加一条「读记忆 → spawn」的规则。
//!
//! 单测只覆盖纯逻辑（标识 / 记忆序列化）；真实注册需要平台环境，由 CI 之外的
//! 手测覆盖（与 autostart.rs 同一取舍）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::logger;

/// 守护进程落盘的 GUI 自启记忆（`<pipe>.gui.json`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuiAutostart {
    pub(crate) version: u32,
    /// WeQ 上次设置的意图：true = 开机后由守护进程拉起 GUI。
    pub(crate) enabled: bool,
    /// 要拉起的 GUI 可执行文件（绝对路径）。
    pub(crate) gui_exe: String,
}

const GUI_STATE_VERSION: u32 = 1;

/// 状态目录内 GUI 记忆文件的完整路径（可注入单测）。
pub fn gui_file_in(dir: &std::path::Path, pipe_name: &str) -> PathBuf {
    dir.join(format!("{pipe_name}.gui.json"))
}

/// 读取 GUI 自启记忆；无效（损坏 / 版本不符 / 路径为空）时删文件并返回 None。
pub fn load_gui(dir: &std::path::Path, pipe_name: &str) -> Option<GuiAutostart> {
    let path = gui_file_in(dir, pipe_name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return None,
    };
    match serde_json::from_str::<GuiAutostart>(&raw) {
        Ok(g) if g.version == GUI_STATE_VERSION && !g.gui_exe.trim().is_empty() => Some(g),
        _ => {
            logger::warn(&format!(
                "invalid gui state file {} — removing",
                path.display()
            ));
            let _ = std::fs::remove_file(&path);
            None
        }
    }
}

/// 原子落盘 GUI 自启记忆（tmp + rename，与 persist.rs 同一姿势）。
pub fn save_gui(dir: &std::path::Path, pipe_name: &str, enabled: bool, gui_exe: &str) {
    if let Err(err) = std::fs::create_dir_all(dir) {
        logger::warn(&format!("create gui state dir failed: {err}"));
        return;
    }
    let path = gui_file_in(dir, pipe_name);
    let payload = GuiAutostart {
        version: GUI_STATE_VERSION,
        enabled,
        gui_exe: gui_exe.to_string(),
    };
    let Ok(json) = serde_json::to_string_pretty(&payload) else {
        return;
    };
    let tmp = dir.join(format!("{pipe_name}.gui.json.tmp"));
    if let Err(err) = std::fs::write(&tmp, json) {
        logger::warn(&format!("write gui state tmp failed: {err}"));
        return;
    }
    if let Err(err) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&path);
        if let Err(err2) = std::fs::rename(&tmp, &path) {
            logger::warn(&format!("persist gui state failed: {err} / {err2}"));
            return;
        }
    }
    logger::info(&format!(
        "gui autostart memory saved: enabled={enabled} exe={gui_exe}"
    ));
}

/// 删除 GUI 自启记忆（显式关闭时调用；失败忽略）。
pub fn clear_gui(dir: &std::path::Path, pipe_name: &str) {
    let _ = std::fs::remove_file(gui_file_in(dir, pipe_name));
}

/// 状态目录（复用 persist.rs 的解析）。
fn state_dir() -> Option<PathBuf> {
    crate::persist::release_state_dir()
}

/// `serve` 启动时按记忆拉起 GUI（enabled = true 才拉）。失败只记日志。
///
/// 这是 GUI 唯一的开机拉起路径 —— 没有任何原生自启注册参与。
pub fn launch_gui_on_boot(pipe_name: &str) {
    let Some(dir) = state_dir() else { return };
    let Some(memory) = load_gui(&dir, pipe_name) else {
        return;
    };
    if !memory.enabled {
        return;
    }
    spawn_gui(&memory.gui_exe);
}

/// 拉起 GUI（detached；失败只记日志 —— GUI 起不来不该影响守护进程）。
fn spawn_gui(gui_exe: &str) {
    let mut cmd = std::process::Command::new(gui_exe);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0020); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    }
    match cmd.spawn() {
        Ok(_child) => {
            logger::info(&format!("launched weq gui on boot: {gui_exe}"));
        }
        Err(err) => {
            logger::warn(&format!("launch weq gui failed ({gui_exe}): {err}"));
        }
    }
}

// ── 历史残留清理（迁移用，只删不建） ──────────────────────────────────────

/// 旧的「GUI 原生自启」注册标识（任务名 / label / unit 名）。
///
/// 早先版本里 WeQ 自己也注册过一个原生自启（`<ident>-gui`），后来改成「GUI 只由
/// 守护进程拉起」。这个标识只用于把那些残留注册卸掉。
pub fn legacy_ident(pipe_name: &str) -> String {
    format!("{}-gui", crate::autostart::ident(pipe_name))
}

/// 卸载历史残留的 GUI 原生自启注册（幂等；本来就不在也算成功）。
///
/// **只删不建**：不注册任何东西，纯粹的迁移清理。确认所有用户都升过一次之后，
/// 这块连同 `legacy_ident` 可以整体删掉。
pub fn remove_legacy_registration(pipe_name: &str) {
    if let Err(err) = unregister_legacy_platform(pipe_name) {
        logger::warn(&format!(
            "legacy gui autostart cleanup failed ({err}) — it may still fire on next login"
        ));
    }
}

#[cfg(windows)]
fn unregister_legacy_platform(pipe_name: &str) -> Result<(), String> {
    let name = legacy_ident(pipe_name);
    // 查到存在才删，避免把「没装过」当失败。
    match crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Query", "/TN", &name])
        .output()
    {
        Ok(out) if out.status.success() => {}
        _ => return Ok(()),
    }
    let out = crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Delete", "/F", "/TN", &name])
        .output()
        .map_err(|e| format!("schtasks delete gui: spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "schtasks delete gui failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    logger::info(&format!("legacy gui autostart removed: task {name}"));
    Ok(())
}

#[cfg(target_os = "macos")]
fn unregister_legacy_platform(pipe_name: &str) -> Result<(), String> {
    let label = legacy_ident(pipe_name);
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(());
    };
    let plist_path = home.join(format!("Library/LaunchAgents/{label}.plist"));
    if !plist_path.exists() {
        return Ok(());
    }
    // 已加载的话顺手 bootout（失败忽略）：删掉 plist 本身才是关键 —— launchd
    // 只在登录时扫 `~/Library/LaunchAgents/`，文件没了就不会再被拉起。
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", label.as_str()])
        .output();
    std::fs::remove_file(&plist_path)
        .map_err(|e| format!("remove {}: {e}", plist_path.display()))?;
    logger::info(&format!("legacy gui autostart removed: {label}"));
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unregister_legacy_platform(pipe_name: &str) -> Result<(), String> {
    let unit = legacy_ident(pipe_name);
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(());
    };
    let dir = home.join(".config/systemd/user");
    let unit_path = dir.join(format!("{unit}.service"));
    if !unit_path.exists() {
        return Ok(());
    }
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", &format!("{unit}.service")])
        .output();
    std::fs::remove_file(&unit_path).map_err(|e| format!("remove {}: {e}", unit_path.display()))?;
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output();
    logger::info(&format!("legacy gui autostart removed: {unit}.service"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "weq-daemon-gui-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn legacy_ident_appends_suffix() {
        assert_eq!(legacy_ident("weq-daemon"), "weq-daemon-gui");
        assert_eq!(
            legacy_ident("weq-daemon-test"),
            "weq-daemon-weq-daemon-test-gui"
        );
    }

    #[test]
    fn gui_memory_roundtrip() {
        let dir = temp_dir("roundtrip");
        let _ = std::fs::remove_dir_all(&dir);

        save_gui(&dir, "weq-daemon-test", true, "/opt/WeQ/weq");
        let memory = load_gui(&dir, "weq-daemon-test").unwrap();
        assert!(memory.enabled);
        assert_eq!(memory.gui_exe, "/opt/WeQ/weq");

        save_gui(&dir, "weq-daemon-test", false, "/opt/WeQ/weq");
        let memory = load_gui(&dir, "weq-daemon-test").unwrap();
        assert!(!memory.enabled);

        clear_gui(&dir, "weq-daemon-test");
        assert!(load_gui(&dir, "weq-daemon-test").is_none());
        assert!(!gui_file_in(&dir, "weq-daemon-test").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_gui_memory_is_removed() {
        let dir = temp_dir("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bad = gui_file_in(&dir, "weq-daemon-test");
        std::fs::write(&bad, "{ nope").unwrap();
        assert!(load_gui(&dir, "weq-daemon-test").is_none());
        assert!(!bad.exists(), "corrupt file must be removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_exe_memory_is_rejected() {
        let dir = temp_dir("empty-exe");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bad = gui_file_in(&dir, "weq-daemon-test");
        std::fs::write(&bad, r#"{"version":1,"enabled":true,"gui_exe":"  "}"#).unwrap();
        assert!(
            load_gui(&dir, "weq-daemon-test").is_none(),
            "empty gui_exe must never be launched"
        );
        assert!(!bad.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
