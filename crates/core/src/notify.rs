//! Events the core sends from places that hold no `AppState`: the source
//! engine's notices, translation progress. The app installs its event
//! sink when it starts; without one (tests, tools) events go nowhere.

use std::sync::{Arc, RwLock};

static EVENTS: RwLock<Option<Arc<dyn crate::api::Events>>> = RwLock::new(None);

pub fn set_events(events: Arc<dyn crate::api::Events>) {
    if let Ok(mut slot) = EVENTS.write() {
        *slot = Some(events);
    }
}

/// Sends `payload` to the page as `event`.
pub fn emit(event: &str, payload: impl serde::Serialize) {
    #[cfg(test)]
    if testing::record(event, &payload) {
        return;
    }
    if let Some(events) = EVENTS.read().ok().and_then(|slot| slot.clone()) {
        events.emit(event, serde_json::to_value(payload).unwrap_or_default());
    }
}

#[cfg(test)]
pub mod testing {
    //! Events sent on this thread, for tests.
    use std::cell::RefCell;

    thread_local! {
        static SENT: RefCell<Option<Vec<(String, serde_json::Value)>>> = const { RefCell::new(None) };
    }

    pub(super) fn record(event: &str, payload: &impl serde::Serialize) -> bool {
        SENT.with(|sent| match sent.borrow_mut().as_mut() {
            Some(list) => {
                list.push((
                    event.to_string(),
                    serde_json::to_value(payload).unwrap_or_default(),
                ));
                true
            }
            None => false,
        })
    }

    /// Runs `work` and answers what it sent.
    pub fn capture<R>(work: impl FnOnce() -> R) -> (R, Vec<(String, serde_json::Value)>) {
        SENT.with(|sent| *sent.borrow_mut() = Some(Vec::new()));
        let result = work();
        let sent = SENT.with(|sent| sent.borrow_mut().take().unwrap_or_default());
        (result, sent)
    }
}
