//! Agent graph state built ONLY from observed events. Relationships come from
//! `task_started.tool_use_id` + the caller of that tool use (hook `agent_id`);
//! nothing is inferred. Unobservable outcomes become `Unknown`.
use crate::model::{now_ms, AgentNode, AgentStatus};
use std::collections::HashMap;

pub struct Tracker {
    pub session_id: String,
    pub agents: HashMap<String, AgentNode>,
    /// tool_use_id -> agent that issued it (from PreToolUse / can_use_tool).
    caller: HashMap<String, String>,
    /// Agent-tool tool_use_id -> spawned agent id (from task_started).
    spawned_by_tool: HashMap<String, String>,
}

fn terminal(s: AgentStatus) -> bool {
    matches!(s, AgentStatus::Done | AgentStatus::Error | AgentStatus::Unknown)
}

impl Tracker {
    pub fn new(session_id: &str, existing: Vec<AgentNode>) -> Tracker {
        let mut t = Tracker { session_id: session_id.into(), agents: HashMap::new(), caller: HashMap::new(), spawned_by_tool: HashMap::new() };
        for a in existing {
            if let Some(tu) = &a.tool_use_id {
                t.spawned_by_tool.insert(tu.clone(), a.id.clone());
            }
            t.agents.insert(a.id.clone(), a);
        }
        t
    }

    pub fn root_id(&self) -> String {
        self.session_id.clone()
    }

    fn root(&mut self) -> &mut AgentNode {
        let id = self.root_id();
        self.agents.entry(id.clone()).or_insert_with(|| AgentNode {
            id,
            session_id: self.session_id.clone(),
            parent_id: None,
            kind: "orchestrator".into(),
            name: "Claude".into(),
            description: Some("Orquestrador da sessão".into()),
            status: AgentStatus::Idle,
            current_tool: None,
            activity: None,
            started_at: now_ms(),
            ended_at: None,
            tool_uses: 0,
            tokens: None,
            tool_use_id: None,
        })
    }

    fn agent_or_root(&mut self, agent_id: Option<&str>) -> String {
        match agent_id {
            Some(a) if !a.is_empty() => {
                if !self.agents.contains_key(a) {
                    // Seen in an event before task_started: real id, parent unknown.
                    self.agents.insert(a.to_string(), AgentNode {
                        id: a.to_string(),
                        session_id: self.session_id.clone(),
                        parent_id: None,
                        kind: "subagent".into(),
                        name: "subagente".into(),
                        description: None,
                        status: AgentStatus::Running,
                        current_tool: None,
                        activity: None,
                        started_at: now_ms(),
                        ended_at: None,
                        tool_uses: 0,
                        tokens: None,
                        tool_use_id: None,
                    });
                }
                a.to_string()
            }
            _ => {
                self.root();
                self.root_id()
            }
        }
    }

    /// Agent responsible for messages carrying `parent_tool_use_id`.
    pub fn agent_for_parent_tool(&self, ptu: Option<&str>) -> Option<String> {
        ptu.and_then(|p| self.spawned_by_tool.get(p).cloned())
    }

    pub fn turn_started(&mut self) -> AgentNode {
        let r = self.root();
        r.status = AgentStatus::Running;
        r.ended_at = None;
        r.activity = Some("processando".into());
        r.clone()
    }

    pub fn turn_ended(&mut self, is_error: bool) -> AgentNode {
        let r = self.root();
        r.status = if is_error { AgentStatus::Error } else { AgentStatus::Idle };
        r.current_tool = None;
        r.activity = Some(if is_error { "turno terminou com erro".into() } else { "aguardando próxima mensagem".into() });
        r.clone()
    }

    pub fn thinking(&mut self) -> Option<AgentNode> {
        let r = self.root();
        if r.status == AgentStatus::Running && r.current_tool.is_none() {
            if r.activity.as_deref() != Some("pensando") {
                r.activity = Some("pensando".into());
                return Some(r.clone());
            }
        }
        None
    }

    pub fn task_started(&mut self, task_id: &str, tool_use_id: Option<&str>, description: Option<String>, subagent_type: Option<String>) -> AgentNode {
        let parent = tool_use_id.and_then(|tu| self.caller.get(tu).cloned()).unwrap_or_else(|| {
            self.root();
            self.root_id()
        });
        let sid = self.session_id.clone();
        let a = self.agents.entry(task_id.to_string()).or_insert_with(|| AgentNode {
            id: task_id.to_string(),
            session_id: sid,
            parent_id: None,
            kind: "subagent".into(),
            name: "subagente".into(),
            description: None,
            status: AgentStatus::Running,
            current_tool: None,
            activity: None,
            started_at: now_ms(),
            ended_at: None,
            tool_uses: 0,
            tokens: None,
            tool_use_id: None,
        });
        a.parent_id = Some(parent);
        if let Some(t) = subagent_type {
            a.name = t;
        }
        if description.is_some() {
            a.description = description;
        }
        a.tool_use_id = tool_use_id.map(str::to_string);
        if !terminal(a.status) {
            a.status = AgentStatus::Running;
        }
        let out = a.clone();
        if let Some(tu) = tool_use_id {
            self.spawned_by_tool.insert(tu.to_string(), task_id.to_string());
        }
        out
    }

    pub fn subagent_start(&mut self, agent_id: &str, agent_type: Option<String>) -> AgentNode {
        let id = self.agent_or_root(Some(agent_id));
        let a = self.agents.get_mut(&id).unwrap();
        if let Some(t) = agent_type {
            if a.name == "subagente" {
                a.name = t;
            }
        }
        a.status = AgentStatus::Running;
        a.clone()
    }

    pub fn subagent_stop(&mut self, agent_id: &str) -> AgentNode {
        let id = self.agent_or_root(Some(agent_id));
        let a = self.agents.get_mut(&id).unwrap();
        if !matches!(a.status, AgentStatus::Error) {
            a.status = AgentStatus::Done;
        }
        a.current_tool = None;
        a.ended_at.get_or_insert(now_ms());
        a.clone()
    }

    pub fn task_progress(&mut self, task_id: &str, desc: Option<String>, last_tool: Option<String>, tokens: Option<i64>, tool_uses: Option<i64>) -> Option<AgentNode> {
        let a = self.agents.get_mut(task_id)?;
        if desc.is_some() {
            a.activity = desc;
        }
        if let Some(t) = last_tool {
            a.current_tool = Some(t);
        }
        if tokens.is_some() {
            a.tokens = tokens;
        }
        if let Some(n) = tool_uses {
            a.tool_uses = n;
        }
        Some(a.clone())
    }

    pub fn task_status(&mut self, task_id: &str, status: &str) -> Option<AgentNode> {
        let a = self.agents.get_mut(task_id)?;
        a.status = match status {
            "completed" => AgentStatus::Done,
            "failed" | "error" => AgentStatus::Error,
            "killed" | "stopped" | "cancelled" => AgentStatus::Error,
            "running" => AgentStatus::Running,
            _ => return None,
        };
        if terminal(a.status) {
            a.current_tool = None;
            a.ended_at.get_or_insert(now_ms());
        }
        Some(a.clone())
    }

    pub fn pre_tool(&mut self, agent_id: Option<&str>, tool_use_id: Option<&str>, tool: &str, summary: String) -> AgentNode {
        let id = self.agent_or_root(agent_id);
        if let Some(tu) = tool_use_id {
            self.caller.insert(tu.to_string(), id.clone());
        }
        let a = self.agents.get_mut(&id).unwrap();
        a.status = AgentStatus::Tool;
        a.current_tool = Some(tool.to_string());
        a.activity = Some(summary);
        if a.kind == "orchestrator" {
            a.tool_uses += 1;
        }
        a.clone()
    }

    pub fn post_tool(&mut self, agent_id: Option<&str>) -> AgentNode {
        let id = self.agent_or_root(agent_id);
        let a = self.agents.get_mut(&id).unwrap();
        if !terminal(a.status) {
            a.status = AgentStatus::Running;
        }
        a.current_tool = None;
        a.clone()
    }

    pub fn awaiting(&mut self, agent_id: Option<&str>, tool_use_id: Option<&str>, tool: &str) -> AgentNode {
        let id = self.agent_or_root(agent_id);
        if let Some(tu) = tool_use_id {
            self.caller.entry(tu.to_string()).or_insert(id.clone());
        }
        let a = self.agents.get_mut(&id).unwrap();
        a.status = AgentStatus::AwaitingApproval;
        a.current_tool = Some(tool.to_string());
        a.clone()
    }

    /// Process ended: anything still non-terminal has an unobservable fate.
    pub fn process_ended(&mut self, clean: bool) -> Vec<AgentNode> {
        let root = self.root_id();
        let mut out = vec![];
        for a in self.agents.values_mut() {
            if a.id == root {
                let s = if clean { AgentStatus::Idle } else { AgentStatus::Unknown };
                if a.status != s {
                    a.status = s;
                    a.current_tool = None;
                    a.activity = Some(if clean { "processo encerrado (retomável)".into() } else { "processo encerrado; estado final não observado".into() });
                    out.push(a.clone());
                }
            } else if !terminal(a.status) {
                a.status = AgentStatus::Unknown;
                a.current_tool = None;
                a.activity = Some("processo encerrado; estado final não observado".into());
                out.push(a.clone());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subagent_parent_comes_from_caller_of_agent_tool() {
        let mut t = Tracker::new("S", vec![]);
        t.turn_started();
        t.pre_tool(None, Some("tu1"), "Agent", "Agent: x".into());
        let a = t.task_started("A1", Some("tu1"), Some("x".into()), Some("explorer".into()));
        assert_eq!(a.parent_id.as_deref(), Some("S"));
        // nested: A1 spawns A2
        t.pre_tool(Some("A1"), Some("tu2"), "Agent", "Agent: y".into());
        let b = t.task_started("A2", Some("tu2"), None, Some("coder".into()));
        assert_eq!(b.parent_id.as_deref(), Some("A1"));
        assert_eq!(t.agent_for_parent_tool(Some("tu2")).as_deref(), Some("A2"));
    }
    #[test]
    fn statuses_and_unknown_on_crash() {
        let mut t = Tracker::new("S", vec![]);
        t.task_started("A1", None, None, None);
        assert_eq!(t.awaiting(Some("A1"), Some("tu"), "Write").status, AgentStatus::AwaitingApproval);
        assert_eq!(t.post_tool(Some("A1")).status, AgentStatus::Running);
        t.task_started("A2", None, None, None);
        t.task_status("A2", "completed");
        let changed = t.process_ended(false);
        assert!(changed.iter().any(|a| a.id == "A1" && a.status == AgentStatus::Unknown));
        assert!(!changed.iter().any(|a| a.id == "A2"));
    }
}
