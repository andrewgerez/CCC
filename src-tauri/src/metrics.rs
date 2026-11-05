//! Process metrics from /proc (no polling when the UI is hidden and nothing
//! is running). CPU% is computed from utime+stime deltas between samples.
use crate::model::ProcStat;
use std::collections::HashMap;

fn clk_tck() -> f64 {
    nix::unistd::sysconf(nix::unistd::SysconfVar::CLK_TCK).ok().flatten().unwrap_or(100) as f64
}
fn page_size() -> i64 {
    nix::unistd::sysconf(nix::unistd::SysconfVar::PAGE_SIZE).ok().flatten().unwrap_or(4096) as i64
}

pub struct ProcInfo {
    pub ticks: u64,
    pub rss: i64,
    pub comm: String,
}

pub fn read_proc(pid: i64) -> Option<ProcInfo> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat[open + 1..close].to_string();
    let rest: Vec<&str> = stat[close + 2..].split_whitespace().collect();
    // fields after comm: state(0) ppid(1) ... utime(11) stime(12) ... rss(21)
    let utime: u64 = rest.get(11)?.parse().ok()?;
    let stime: u64 = rest.get(12)?.parse().ok()?;
    let rss_pages: i64 = rest.get(21)?.parse().ok()?;
    Some(ProcInfo { ticks: utime + stime, rss: rss_pages * page_size(), comm })
}

pub fn children(pid: i64) -> Vec<i64> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for t in rd.filter_map(Result::ok) {
            if let Ok(c) = std::fs::read_to_string(t.path().join("children")) {
                out.extend(c.split_whitespace().filter_map(|x| x.parse::<i64>().ok()));
            }
        }
    }
    out
}

pub fn tree(pid: i64) -> Vec<i64> {
    let mut all = vec![pid];
    let mut i = 0;
    while i < all.len() && all.len() < 512 {
        let kids = children(all[i]);
        all.extend(kids);
        i += 1;
    }
    all
}

/// Remembers previous tick counts to compute CPU%.
#[derive(Default)]
pub struct Sampler {
    prev: HashMap<i64, (u64, std::time::Instant)>,
}

impl Sampler {
    pub fn sample(&mut self, pids: &[i64]) -> ProcStat {
        let now = std::time::Instant::now();
        let tck = clk_tck();
        let mut st = ProcStat { pid: *pids.first().unwrap_or(&0), ..Default::default() };
        for &p in pids {
            if let Some(info) = read_proc(p) {
                st.rss_bytes += info.rss;
                st.procs += 1;
                if let Some((pt, pi)) = self.prev.get(&p) {
                    let dt = now.duration_since(*pi).as_secs_f64();
                    if dt > 0.0 {
                        st.cpu_percent += (info.ticks.saturating_sub(*pt)) as f64 / tck / dt * 100.0;
                    }
                }
                self.prev.insert(p, (info.ticks, now));
            }
        }
        st
    }
    pub fn gc(&mut self) {
        self.prev.retain(|p, _| std::path::Path::new(&format!("/proc/{p}")).exists());
    }
}

/// Finds processes we started (marker env) that are not children of `me`:
/// orphans left by a crash. Reads only our own uid's /proc entries.
pub fn find_orphans(marker: &str, me: i64) -> Vec<(i64, String)> {
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir("/proc") else { return out };
    let mine: std::collections::HashSet<i64> = tree(me).into_iter().collect();
    for e in rd.filter_map(Result::ok) {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i64>() else { continue };
        if mine.contains(&pid) {
            continue;
        }
        let Ok(env) = std::fs::read(format!("/proc/{pid}/environ")) else { continue };
        let needle = format!("{marker}=");
        if let Some(run) = env.split(|b| *b == 0).find_map(|kv| {
            let s = String::from_utf8_lossy(kv);
            s.strip_prefix(&needle).map(str::to_string)
        }) {
            out.push((pid, run));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_self() {
        let me = std::process::id() as i64;
        let p = read_proc(me).unwrap();
        assert!(p.rss > 0);
        let mut s = Sampler::default();
        let st = s.sample(&tree(me));
        assert!(st.procs >= 1);
    }
}
