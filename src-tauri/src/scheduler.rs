//! Global concurrency limit with per-account queues and priorities.
//! A `Permit` is held for the lifetime of a live Claude process; dropping it
//! frees the slot and dispatches the next waiter. Fairness: highest priority
//! first; on ties, the account that ran least recently; then FIFO.
use crate::accounts::AccountId;
use crate::model::SchedulerView;
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::oneshot;

struct Waiter {
    id: String,
    account: AccountId,
    priority: i32,
    seq: u64,
    tx: oneshot::Sender<Permit>,
}

struct Inner {
    limit: u32,
    running: u32,
    queue: Vec<Waiter>,
    seq: u64,
    last_account: Option<AccountId>,
}

pub struct Scheduler {
    inner: Mutex<Inner>,
    on_change: Box<dyn Fn(SchedulerView) + Send + Sync>,
}

pub struct Permit {
    sched: Option<Arc<Scheduler>>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        if let Some(s) = self.sched.take() {
            let view = {
                let mut g = s.inner.lock();
                g.running = g.running.saturating_sub(1);
                Scheduler::dispatch(&s, &mut g);
                Scheduler::view_of(&g)
            };
            (s.on_change)(view);
        }
    }
}

impl Scheduler {
    pub fn new(limit: u32, on_change: Box<dyn Fn(SchedulerView) + Send + Sync>) -> Arc<Scheduler> {
        Arc::new(Scheduler {
            inner: Mutex::new(Inner { limit: limit.max(1), running: 0, queue: vec![], seq: 0, last_account: None }),
            on_change,
        })
    }

    fn view_of(g: &Inner) -> SchedulerView {
        SchedulerView {
            limit: g.limit,
            running: g.running,
            queued_personal: g.queue.iter().filter(|w| w.account == AccountId::Personal).count() as u32,
            queued_work: g.queue.iter().filter(|w| w.account == AccountId::Work).count() as u32,
        }
    }

    pub fn view(&self) -> SchedulerView {
        Self::view_of(&self.inner.lock())
    }

    fn dispatch(this: &Arc<Scheduler>, g: &mut Inner) {
        while g.running < g.limit && !g.queue.is_empty() {
            let last = g.last_account;
            let best = g
                .queue
                .iter()
                .enumerate()
                .max_by(|(_, a), (_, b)| {
                    a.priority
                        .cmp(&b.priority)
                        .then_with(|| (Some(a.account) != last).cmp(&(Some(b.account) != last)))
                        .then_with(|| b.seq.cmp(&a.seq))
                })
                .map(|(i, _)| i)
                .unwrap();
            let w = g.queue.remove(best);
            g.running += 1;
            g.last_account = Some(w.account);
            // If the waiter is gone, the Permit inside the failed send is
            // dropped... but we hold the lock, so release manually instead.
            if let Err(mut p) = w.tx.send(Permit { sched: Some(this.clone()) }) {
                p.sched = None;
                g.running -= 1;
            }
        }
    }

    /// Wait for a slot. Cancel-safe: dropping the future dequeues the waiter.
    pub async fn acquire(self: &Arc<Self>, id: &str, account: AccountId, priority: i32) -> Permit {
        let rx = {
            let mut g = self.inner.lock();
            let (tx, rx) = oneshot::channel();
            g.seq += 1;
            let seq = g.seq;
            g.queue.push(Waiter { id: id.to_string(), account, priority, seq, tx });
            Self::dispatch(self, &mut g);
            rx
        };
        (self.on_change)(self.view());
        let guard = DequeueOnDrop { sched: self.clone(), id: id.to_string() };
        let permit = rx.await.expect("scheduler never drops queued senders");
        std::mem::forget(guard);
        permit
    }

    pub fn set_limit(self: &Arc<Self>, n: u32) {
        let view = {
            let mut g = self.inner.lock();
            g.limit = n.clamp(1, 16);
            Self::dispatch(self, &mut g);
            Self::view_of(&g)
        };
        (self.on_change)(view);
    }

    pub fn set_priority(self: &Arc<Self>, id: &str, priority: i32) {
        let mut g = self.inner.lock();
        for w in g.queue.iter_mut().filter(|w| w.id == id) {
            w.priority = priority;
        }
    }

    pub fn is_queued(&self, id: &str) -> bool {
        self.inner.lock().queue.iter().any(|w| w.id == id)
    }
}

struct DequeueOnDrop {
    sched: Arc<Scheduler>,
    id: String,
}
impl Drop for DequeueOnDrop {
    fn drop(&mut self) {
        let view = {
            let mut g = self.sched.inner.lock();
            g.queue.retain(|w| w.id != self.id);
            Scheduler::view_of(&g)
        };
        (self.sched.on_change)(view);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sched(n: u32) -> Arc<Scheduler> {
        Scheduler::new(n, Box::new(|_| {}))
    }

    #[tokio::test]
    async fn respects_global_limit_and_releases() {
        let s = sched(2);
        let a = s.acquire("a", AccountId::Personal, 0).await;
        let _b = s.acquire("b", AccountId::Work, 0).await;
        assert_eq!(s.view().running, 2);
        let s2 = s.clone();
        let c = tokio::spawn(async move { s2.acquire("c", AccountId::Personal, 0).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(s.view().queued_personal, 1);
        drop(a);
        let _c = tokio::time::timeout(Duration::from_secs(1), c).await.unwrap().unwrap();
        assert_eq!(s.view().running, 2);
        assert_eq!(s.view().queued_personal, 0);
    }

    #[tokio::test]
    async fn priority_then_account_fairness() {
        let s = sched(1);
        let first = s.acquire("x", AccountId::Personal, 0).await;
        let order = Arc::new(Mutex::new(vec![]));
        let mut hs = vec![];
        for (id, acc, pr) in [("p-low", AccountId::Personal, 0), ("w-low", AccountId::Work, 0), ("p-high", AccountId::Personal, 5)] {
            let (s2, o) = (s.clone(), order.clone());
            hs.push(tokio::spawn(async move {
                let p = s2.acquire(id, acc, pr).await;
                o.lock().push(id);
                tokio::time::sleep(Duration::from_millis(5)).await;
                drop(p);
            }));
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(first);
        for h in hs {
            h.await.unwrap();
        }
        // high priority first; then work (personal ran last) before personal.
        assert_eq!(*order.lock(), vec!["p-high", "w-low", "p-low"]);
    }

    #[tokio::test]
    async fn cancelled_waiter_does_not_leak_slot() {
        let s = sched(1);
        let a = s.acquire("a", AccountId::Personal, 0).await;
        let s2 = s.clone();
        let h = tokio::spawn(async move { s2.acquire("b", AccountId::Work, 0).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        h.abort();
        let _ = h.await;
        assert_eq!(s.view().queued_work, 0);
        drop(a);
        assert_eq!(s.view().running, 0);
        let _c = tokio::time::timeout(Duration::from_secs(1), s.acquire("c", AccountId::Work, 0)).await.unwrap();
    }
}
