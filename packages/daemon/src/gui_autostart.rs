//! WeQ GUI 的开机自启 —— **由守护进程代为注册与拉起**。
//!
//! 按约定，Electron 不注册任何自启动任务：WeQ 通过 `autostart_set {enabled,
//! gui_exe}` 把「意图 + 可执行文件路径」交给守护进程；守护进程：
//!   - enabled = true  → 按平台注册「登录时启动 `<gui_exe>`」（并落记忆）；
//!   - enabled = false → 撤销注册（并落记忆）。
//!
//! 守护进程自己是开机自启的（`weq-daemon serve`），启动时读记忆：
//!   - enabled = true  → spawn `<gui_exe>`（detached，WeQ 不在也拉起来）；
//!   - enabled = false → 什么都不做。
//!
//! 这样「GUI 开机自启」由守护进程的注册体系统一管理：注册里**不含**守护进程
//! 的端口 / docroot（那仍由 WeQ 运行时下发），GUI 的路径则来自 WeQ 的显式委托。
//!
//! 平台注册（与 autostart.rs 的守护进程自启完全同构，仅命令行不同）：
//!   - Windows: `schtasks /SC ONLOGON`（任务名 `weq-daemon` + `-gui` 后缀）
//!   - macOS: `~/Library/LaunchAgents/<ident>.plist`（RunAtLoad，不 KeepAlive —— GUI 崩了
//!     该由用户自己再开，不要闹鬼式复活）
//!   - Linux: systemd user unit（`WantedBy=default.target`）
//!
//! 单测只覆盖纯逻辑（ident / 记忆序列化）；真实注册需要平台环境，由 CI 之外
//! 的手测覆盖（与 autostart.rs 同一取舍）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::logger;

/// 守护进程落盘的 GUI 自启记忆（`<pipe>.gui.json`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GuiAutostart {
    pub(crate) version: u32,
    /// WeQ 上次设置的意图：true = 应注册并拉起。
    pub(crate) enabled: bool,
    /// 要拉起的 GUI 可执行文件（绝对路径）。
    pub(crate) gui_exe: String,
}

const GUI_STATE_VERSION: u32 = 1;

/// GUI 自启注册的标识（任务名 / label / unit 名）。
pub fn gui_ident(pipe_name: &str) -> String {
    format!("{}-gui", crate::autostart::ident(pipe_name))
}

/// 状态目录内 GUI 记忆文件的完整路径（可注入单测）。
pub fn gui_file_in(dir: &std::path::Path, pipe_name: &str) -> PathBuf {
    dir.join(format!("{pipe_name}.gui.json"))
}

/// 读取 GUI 自启记忆；无效（损坏 / 版本不符）时删文件并返回 None。
pub fn load_gui(dir: &std::path::Path, pipe_name: &str) -> Option<GuiAutostart> {
    let path = gui_file_in(dir, pipe_name);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return None,
    };
    match serde_json::from_str::<GuiAutostart>(&raw) {
        Ok(g) if g.version == GUI_STATE_VERSION && !g.gui_exe.is_empty() => Some(g),
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

/// 删除 GUI 自启记忆（显式关闭且卸载成功后调用；失败忽略）。
pub fn clear_gui(dir: &std::path::Path, pipe_name: &str) {
    let _ = std::fs::remove_file(gui_file_in(dir, pipe_name));
}

/// 状态目录（复用 persist.rs 的解析）。
fn state_dir() -> Option<std::path::PathBuf> {
    crate::persist::release_state_dir()
}

// ── 平台注册（登录时启动 GUI） ─────────────────────────────────────────────

/// 注册「登录时启动 `<gui_exe>`」。失败返回错误消息（含平台工具的 stderr）。
pub fn register_gui(pipe_name: &str, gui_exe: &str) -> Result<(), String> {
    if gui_exe.trim().is_empty() {
        return Err("gui_exe is empty".to_string());
    }
    register_platform(pipe_name, gui_exe)
}

/// 撤销 GUI 自启注册。不存在也视为成功（幂等）。
pub fn unregister_gui(pipe_name: &str) -> Result<(), String> {
    unregister_platform(pipe_name)
}

/// 平台注册是否在位（任务 / plist / unit 存在）。
pub fn registered(pipe_name: &str) -> bool {
    registered_platform(pipe_name)
}

/// serve 启动时按记忆拉起 GUI（enabled = true 才拉）。失败只记日志。
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

// ---------- Windows: schtasks ONLOGON ----------

#[cfg(windows)]
fn register_platform(pipe_name: &str, gui_exe: &str) -> Result<(), String> {
    let name = gui_ident(pipe_name);
    // /F = 覆盖已存在任务；/SC ONLOGON = 该用户每次登录时启动。与 autostart.rs
    // 同一姿势：参数数组直接交给 schtasks，/TR 用双引号包住 exe 路径。
    let tr = format!("\"{gui_exe}\"");
    run(
        crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
            .args(crate::autostart::create_args(&name, &tr)),
        "schtasks register gui",
    )?;
    logger::info(&format!("gui autostart installed: task {name}"));
    Ok(())
}

#[cfg(windows)]
fn unregister_platform(pipe_name: &str) -> Result<(), String> {
    let name = gui_ident(pipe_name);
    match crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Query", "/TN", &name])
        .output()
    {
        Ok(out) if out.status.success() => {}
        _ => return Ok(()), // 没装过 = 已是目标状态
    }
    run(
        crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
            .args(["/Delete", "/F", "/TN", &name]),
        "schtasks delete gui",
    )?;
    logger::info(&format!("gui autostart removed: task {name}"));
    Ok(())
}

#[cfg(windows)]
fn registered_platform(pipe_name: &str) -> bool {
    let name = gui_ident(pipe_name);
    crate::autostart::no_window(&mut std::process::Command::new("schtasks"))
        .args(["/Query", "/TN", &name])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ---------- macOS: LaunchAgent plist ----------

#[cfg(target_os = "macos")]
fn register_platform(pipe_name: &str, gui_exe: &str) -> Result<(), String> {
    let label = gui_ident(pipe_name);
    let agents_dir = home_dir()?.join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents_dir).map_err(|e| format!("create LaunchAgents dir: {e}"))?;
    let plist_path = agents_dir.join(format!("{label}.plist"));
    // 只 RunAtLoad，不 KeepAlive —— GUI 不是服务，崩了不该被自动复活。
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{gui_exe}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
"#
    );
    std::fs::write(&plist_path, plist)
        .map_err(|e| format!("write {}: {e}", plist_path.display()))?;
    // 已加载同名 label 就先 bootout（失败忽略 —— 多半是本来没加载）。
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", &label])
        .output();
    run(
        std::process::Command::new("launchctl")
            .args(["bootstrap", "gui/$UID"])
            .arg(&plist_path),
        "launchctl bootstrap gui",
    )?;
    logger::info(&format!("gui autostart installed: {label}"));
    Ok(())
}

#[cfg(target_os = "macos")]
fn unregister_platform(pipe_name: &str) -> Result<(), String> {
    let label = gui_ident(pipe_name);
    let plist_path = home_dir()?.join(format!("Library/LaunchAgents/{label}.plist"));
    let _ = std::process::Command::new("launchctl")
        .args(["bootout", "gui/$UID", &label])
        .output();
    match std::fs::remove_file(&plist_path) {
        Ok(()) => {
            logger::info(&format!("gui autostart removed: {label}"));
            Ok(())
        }
        Err(_) if !plist_path.exists() => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", plist_path.display())),
    }
}

#[cfg(target_os = "macos")]
fn registered_platform(pipe_name: &str) -> bool {
    match home_dir() {
        Ok(home) => home
            .join(format!(
                "Library/LaunchAgents/{}.plist",
                gui_ident(pipe_name)
            ))
            .exists(),
        Err(_) => false,
    }
}

// ---------- Linux: systemd user unit ----------

#[cfg(all(unix, not(target_os = "macos")))]
fn register_platform(pipe_name: &str, gui_exe: &str) -> Result<(), String> {
    let unit = gui_ident(pipe_name);
    let unit_dir = home_dir()?.join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| format!("create systemd user dir: {e}"))?;
    let unit_path = unit_dir.join(format!("{unit}.service"));
    let content = format!(
        "[Unit]\n\
         Description=WeQ desktop autostart (managed by weq-daemon)\n\
         After=graphical-session.target\n\n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart={gui_exe}\n\
         RemainAfterExit=no\n\n\
         [Install]\n\
         WantedBy=default.target\n"
    );
    std::fs::write(&unit_path, content)
        .map_err(|e| format!("write {}: {e}", unit_path.display()))?;
    run(
        std::process::Command::new("systemctl").args(["--user", "daemon-reload"]),
        "systemctl daemon-reload gui",
    )?;
    run(
        std::process::Command::new("systemctl").args([
            "--user",
            "enable",
            "--now",
            &format!("{unit}.service"),
        ]),
        "systemctl enable gui",
    )?;
    logger::info(&format!("gui autostart installed: {unit}.service"));
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unregister_platform(pipe_name: &str) -> Result<(), String> {
    let unit = gui_ident(pipe_name);
    let unit_path = home_dir()?.join(format!(".config/systemd/user/{unit}.service"));
    let _ = std::process::Command::new("systemctl")
        .args(["--user", "disable", "--now", &format!("{unit}.service")])
        .output();
    match std::fs::remove_file(&unit_path) {
        Ok(()) => {
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            logger::info(&format!("gui autostart removed: {unit}.service"));
            Ok(())
        }
        Err(_) if !unit_path.exists() => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", unit_path.display())),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn registered_platform(pipe_name: &str) -> bool {
    match home_dir() {
        Ok(home) => home
            .join(format!(
                ".config/systemd/user/{}.service",
                gui_ident(pipe_name)
            ))
            .exists(),
        Err(_) => false,
    }
}

// ---------- shared helpers ----------

fn run(cmd: &mut std::process::Command, what: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{what}: spawn failed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{what} failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(target_os = "macos")]
fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn home_dir() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gui_ident_appends_suffix() {
        assert_eq!(gui_ident("weq-daemon"), "weq-daemon-gui");
        assert_eq!(
            gui_ident("weq-daemon-test"),
            "weq-daemon-weq-daemon-test-gui"
        );
    }

    #[test]
    fn gui_memory_roundtrip() {
        let dir = std::env::temp_dir().join(format!(
            "weq-daemon-gui-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
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
        let dir =
            std::env::temp_dir().join(format!("weq-daemon-gui-test-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bad = gui_file_in(&dir, "weq-daemon-test");
        std::fs::write(&bad, "{ nope").unwrap();
        assert!(load_gui(&dir, "weq-daemon-test").is_none());
        assert!(!bad.exists(), "corrupt file must be removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_exe_rejected() {
        assert!(register_gui("weq-daemon-test", "  ").is_err());
    }
}
