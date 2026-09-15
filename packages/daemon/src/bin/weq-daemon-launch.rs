//! Windows 的「隐藏拉起器」：计划任务的动作指向它，由它拉起真正的守护进程。
//!
//! 为什么需要单独一个可执行文件：Windows 计划任务在用户会话里 `CreateProcess`
//! 一个**控制台子系统**程序时，系统会为它分配一个 conhost 窗口。守护进程是常驻
//! 进程，于是那个窗口会一直挂在桌面上、不会自己关闭（1.0.2 的真实反馈），用户
//! 点掉窗口还等于顺手杀掉守护进程。
//!
//! 本程序编译成 **GUI 子系统**（见下面的 `windows_subsystem` 属性），永远不创建
//! 控制台窗口；它再把 `weq-daemon.exe` 以 `DETACHED_PROCESS` 拉起 —— 登录时既
//! 没有常驻窗口，也没有一闪而过的黑框。
//!
//! 它只做这一件事：不做单例、不看状态、不碰管道 —— 那些都是守护进程自己的事。
//! 参数原样转发（注册的动作是 `weq-daemon-launch.exe serve --pipe <name>`，与
//! 守护进程自己接受的命令行完全一致），失败写进状态目录的 `daemon.log`。
//!
//! 兜底：拉起器不在时守护进程会退回「注册自己」（见 `autostart.rs`），自启不会
//! 因为少一个文件就坏掉 —— 只是又会带一个窗口。

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 被拉起的守护进程文件名（与 GUI 侧 `stagedDaemonPath` 同构）。
#[cfg(windows)]
const DAEMON_FILE: &str = "weq-daemon.exe";
#[cfg(not(windows))]
const DAEMON_FILE: &str = "weq-daemon";

/// 日志文件超过它就轮换一份（守护进程日志很稀疏，1 MiB 够查很久）。
const LOG_MAX_BYTES: u64 = 1024 * 1024;

fn main() {
    let Ok(exe) = std::env::current_exe() else {
        std::process::exit(2);
    };
    let log = log_path();
    let daemon = sibling(&exe, DAEMON_FILE);
    if let Err(err) = launch(&daemon, log.as_deref()) {
        note(
            log.as_deref(),
            &format!("[ERROR] launch failed ({}): {err}", daemon.display()),
        );
        std::process::exit(1);
    }
}

/// 同目录下的兄弟文件：拉起器与守护进程本体永远同进同出（GUI 侧一起 stage）。
fn sibling(exe: &Path, name: &str) -> PathBuf {
    exe.parent().unwrap_or_else(|| Path::new(".")).join(name)
}

/// 日志路径（状态目录与 `persist.rs` / GUI 侧 `daemonStateDir` 保持一致）。
fn log_path() -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(dir).join("weq-daemon").join("daemon.log"))
}

/// 拉起守护进程：stdio 全部接进日志文件。
///
/// 没有控制台，stderr 本来没人看；落到文件后「开机那次到底怎么了」还能捡回来
/// （1.0.2 只能靠那个本不该存在的窗口看日志）。进程与拉起器解耦：拉起器退出后
/// 守护进程照常活着，也不要求计划任务跟踪它。
fn launch(daemon: &Path, log: Option<&Path>) -> std::io::Result<()> {
    let mut cmd = Command::new(daemon);
    cmd.args(std::env::args().skip(1));
    cmd.stdin(Stdio::null());
    match log.and_then(open_log) {
        Some(file) => {
            cmd.stdout(Stdio::from(file.try_clone()?));
            cmd.stderr(Stdio::from(file));
        }
        None => {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS：新进程不挂控制台（也就没有窗口）；
        // CREATE_NEW_PROCESS_GROUP：与拉起器分家，拉起器退出不影响它。
        cmd.creation_flags(0x0000_0008 | 0x0000_0020);
    }
    cmd.spawn()?;
    Ok(())
}

/// 打开（必要时先轮换）日志文件；打不开就返回 None —— 日志不该拦住拉起。
fn open_log(path: &Path) -> Option<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok()?;
    }
    if std::fs::metadata(path)
        .map(|meta| meta.len() > LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// 往日志里追加一行（没有日志路径 / 写不进去就放弃）。
fn note(path: Option<&Path>, message: &str) {
    if let Some(mut file) = path.and_then(open_log) {
        let _ = writeln!(file, "{message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "weq-launch-{name}-{}-{}.log",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn sibling_lands_next_to_self() {
        let exe = Path::new("state").join("bin").join("weq-daemon-launch");
        assert_eq!(
            sibling(&exe, DAEMON_FILE),
            Path::new("state").join("bin").join(DAEMON_FILE)
        );
    }

    #[test]
    fn note_appends_to_the_log() {
        let path = temp_path("note");
        let _ = std::fs::remove_file(&path);

        note(Some(&path), "first");
        note(Some(&path), "second");

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn oversized_log_rotates_to_one_previous_file() {
        let path = temp_path("rotate");
        let rotated = path.with_extension("log.1");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&rotated);
        std::fs::write(&path, vec![b'x'; LOG_MAX_BYTES as usize + 1]).unwrap();

        drop(open_log(&path).expect("log opens"));

        assert!(rotated.is_file(), "oversized log must rotate to .1");
        assert!(path.is_file(), "a fresh log starts after the rotation");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&rotated);
    }
}
