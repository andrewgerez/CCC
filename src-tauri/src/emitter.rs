//! Batches UI events and flushes them to the webview on one channel.
//! ~40ms cadence when visible, 500ms when hidden. Consecutive text deltas of
//! the same message are merged; deltas are droppable under pressure (the
//! final assistant message always arrives as a durable `chat` event).
use crate::model::UiEvent;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

pub const CHANNEL: &str = "ccc://events";

#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::Sender<UiEvent>,
    pub visible: Arc<AtomicBool>,
}

impl Emitter {
    pub fn new(sink: impl Fn(Vec<UiEvent>) + Send + 'static) -> Emitter {
        let (tx, rx) = mpsc::channel::<UiEvent>(8192);
        let visible = Arc::new(AtomicBool::new(true));
        tauri::async_runtime::spawn(run(rx, sink, visible.clone()));
        Emitter { tx, visible }
    }

    /// Durable events: awaited, never dropped.
    pub async fn send(&self, ev: UiEvent) {
        let _ = self.tx.send(ev).await;
    }

    /// Best-effort (deltas, metrics): dropped if the queue is full.
    pub fn try_send(&self, ev: UiEvent) {
        let _ = self.tx.try_send(ev);
    }

    /// Fire-and-forget from sync code.
    pub fn send_blocking_safe(&self, ev: UiEvent) {
        let tx = self.tx.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(ev).await;
        });
    }
}

pub fn merge_into(batch: &mut Vec<UiEvent>, ev: UiEvent) {
    if let UiEvent::Delta { message_id, text, session_id, .. } = &ev {
        if let Some(UiEvent::Delta { message_id: m2, text: t2, session_id: s2, .. }) = batch.last_mut() {
            if m2 == message_id && s2 == session_id {
                t2.push_str(text);
                return;
            }
        }
    }
    if let UiEvent::Metrics { .. } = &ev {
        batch.retain(|e| !matches!(e, UiEvent::Metrics { .. }));
    }
    batch.push(ev);
}

async fn run(mut rx: mpsc::Receiver<UiEvent>, sink: impl Fn(Vec<UiEvent>), visible: Arc<AtomicBool>) {
    loop {
        let first = match rx.recv().await {
            Some(e) => e,
            None => return,
        };
        let mut batch = Vec::with_capacity(64);
        merge_into(&mut batch, first);
        let wait = if visible.load(Ordering::Relaxed) { 40 } else { 500 };
        let deadline = tokio::time::Instant::now() + Duration::from_millis(wait);
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(e)) => {
                    merge_into(&mut batch, e);
                    if batch.len() >= 2000 {
                        break;
                    }
                }
                Ok(None) => {
                    sink(batch);
                    return;
                }
                Err(_) => break,
            }
        }
        sink(batch);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::AccountId;
    fn d(m: &str, t: &str) -> UiEvent {
        UiEvent::Delta { account: AccountId::Personal, session_id: "s".into(), agent_id: None, message_id: m.into(), text: t.into() }
    }
    #[test]
    fn merges_consecutive_deltas() {
        let mut b = vec![];
        merge_into(&mut b, d("m1", "He"));
        merge_into(&mut b, d("m1", "llo"));
        merge_into(&mut b, d("m2", "x"));
        assert_eq!(b.len(), 2);
        match &b[0] {
            UiEvent::Delta { text, .. } => assert_eq!(text, "Hello"),
            _ => panic!(),
        }
    }
}
