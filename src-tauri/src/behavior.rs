//! Summary of an account's behaviour folder (skills, CLAUDE.md, plugin) for the settings UI.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorInfo {
    pub exists: bool,
    pub skills: Vec<String>,
    pub has_claude_md: bool,
    pub is_plugin: bool,
    /// Agents/commands only load when the folder is a plugin.
    pub agents: usize,
    pub commands: usize,
}

fn md_count(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "md")).count())
        .unwrap_or(0)
}

fn skill_names(dir: &Path, out: &mut Vec<String>) {
    if let Ok(it) = std::fs::read_dir(dir) {
        for e in it.flatten() {
            if e.path().join("SKILL.md").is_file() {
                out.push(e.file_name().to_string_lossy().into_owned());
            }
        }
    }
}

pub fn inspect(dir: &Path) -> BehaviorInfo {
    if !dir.is_dir() {
        return BehaviorInfo::default();
    }
    let is_plugin = dir.join(".claude-plugin/plugin.json").is_file();
    let mut skills = vec![];
    skill_names(&dir.join(".claude/skills"), &mut skills);
    if is_plugin {
        skill_names(&dir.join("skills"), &mut skills);
    }
    skills.sort();
    skills.dedup();
    let base = if is_plugin { dir.to_path_buf() } else { dir.join(".claude") };
    BehaviorInfo {
        exists: true,
        skills,
        has_claude_md: dir.join("CLAUDE.md").is_file() || dir.join(".claude/CLAUDE.md").is_file(),
        is_plugin,
        agents: md_count(&base.join("agents")),
        commands: md_count(&base.join("commands")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_skills_memory_and_plugin_parts() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        for s in ["review", "deploy"] {
            std::fs::create_dir_all(d.join(".claude/skills").join(s)).unwrap();
            std::fs::write(d.join(".claude/skills").join(s).join("SKILL.md"), "---\nname: x\n---").unwrap();
        }
        std::fs::create_dir_all(d.join(".claude/skills/not-a-skill")).unwrap();
        std::fs::write(d.join("CLAUDE.md"), "be nice").unwrap();
        let i = inspect(d);
        assert_eq!(i.skills, ["deploy", "review"]);
        assert!(i.has_claude_md && !i.is_plugin);

        std::fs::create_dir_all(d.join(".claude-plugin")).unwrap();
        std::fs::write(d.join(".claude-plugin/plugin.json"), "{}").unwrap();
        std::fs::create_dir_all(d.join("agents")).unwrap();
        std::fs::write(d.join("agents/a.md"), "").unwrap();
        std::fs::create_dir_all(d.join("skills/lint")).unwrap();
        std::fs::write(d.join("skills/lint/SKILL.md"), "").unwrap();
        let i = inspect(d);
        assert!(i.is_plugin);
        assert_eq!(i.agents, 1);
        assert_eq!(i.skills, ["deploy", "lint", "review"]);
    }

    #[test]
    fn missing_folder_is_empty() {
        assert_eq!(inspect(Path::new("/nonexistent/ccc-behavior")), BehaviorInfo::default());
    }
}
