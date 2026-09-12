//! 极简 stderr 日志：时间戳 + 级别 + 消息。
//!
//! 守护进程无控制台窗口（Windows 上从计划任务启动），日志平时没人看；
//! 需要排查时让 WeQ 侧用 `--pipe` 名或计划任务里临时加 `WEQ_DAEMON_STDERR=1`
//! 重定向即可。刻意不引入 tracing/log 框架 —— 职责越少越不会烂。

use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

/// 初始化（预留：目前只有 stderr 输出，无配置项）。
pub fn init() {}

pub fn log(level: &str, msg: &str) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // 简 J1970 → UTC，够诊断用，不引 chrono。
    let (y, mo, d, h, mi, s) = civil_from_unix(secs);
    let stderr = std::io::stderr();
    let mut lock = stderr.lock();
    let _ = writeln!(
        lock,
        "{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{millis:03} [{level}] {msg}"
    );
}

pub fn info(msg: &str) {
    log("INFO", msg);
}

pub fn warn(msg: &str) {
    log("WARN", msg);
}

pub fn error(msg: &str) {
    log("ERROR", msg);
}

/// unix 秒 → UTC (年, 月, 日, 时, 分, 秒)。Howard Hinnant 的 civil_from_days。
fn civil_from_unix(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    (
        year as u64,
        m as u64,
        d as u64,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_unix_known_values() {
        // 2026-09-07T00:00:00Z == 1788739200
        assert_eq!(civil_from_unix(1_788_739_200), (2026, 9, 7, 0, 0, 0));
        // epoch
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        // 2000-02-29T23:59:59Z（闰年）
        assert_eq!(civil_from_unix(951_868_799), (2000, 2, 29, 23, 59, 59));
    }
}
