//! 下载管理: the app-wide queue of online chapter downloads. Jobs outlive
//! the page that added them; a few books download at once, each with a few
//! chapters in flight, and the queue is kept in `downloads.json` so jobs
//! left unfinished show as paused after a restart. On Android a foreground
//! service with a progress notification keeps the process alive while the
//! app is in the background.

use crate::error::{AppError, ErrorCode};
use crate::models::{DownloadJob, DownloadState};
use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A failed chapter is asked for this many times in all.
const ATTEMPTS: u32 = 3;
const ENGINE_STACK: usize = 16 * 1024 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(250);

/// What the queue needs from the library: a book's chapter count and kept
/// chapters, and fetching one chapter.
pub trait ChapterStore: Send + Sync {
    fn chapters(&self, book_id: &str) -> Result<(u32, BTreeSet<u32>), AppError>;
    fn fetch(&self, book_id: &str, index: u32) -> Result<(), AppError>;
}

/// How many books download at once, and chapters per book.
pub type Limits = Arc<dyn Fn() -> (usize, usize) + Send + Sync>;
/// Called with every job after a change: the frontend event and notification.
pub type Listener = Arc<dyn Fn(&[DownloadJob]) + Send + Sync>;

struct Job {
    info: DownloadJob,
    stop: Arc<AtomicBool>,
}

struct Inner {
    jobs: Mutex<Vec<Job>>,
    store: Arc<dyn ChapterStore>,
    limits: Limits,
    listener: Listener,
    file: Option<PathBuf>,
    last_emit: Mutex<Option<Instant>>,
}

#[derive(Clone)]
pub struct Downloads {
    inner: Arc<Inner>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

impl Downloads {
    /// `file` keeps the queue between runs; jobs that were running come back paused.
    pub fn new(
        store: Arc<dyn ChapterStore>,
        limits: Limits,
        listener: Listener,
        file: Option<PathBuf>,
    ) -> Self {
        let saved: Vec<DownloadJob> = file
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let jobs = saved
            .into_iter()
            .map(|mut info| {
                if matches!(info.state, DownloadState::Running | DownloadState::Queued) {
                    info.state = DownloadState::Paused;
                }
                Job {
                    info,
                    stop: Arc::new(AtomicBool::new(false)),
                }
            })
            .collect();
        Self {
            inner: Arc::new(Inner {
                jobs: Mutex::new(jobs),
                store,
                limits,
                listener,
                file,
                last_emit: Mutex::new(None),
            }),
        }
    }

    pub fn list(&self) -> Vec<DownloadJob> {
        lock(&self.inner.jobs)
            .iter()
            .map(|job| job.info.clone())
            .collect()
    }

    /// Adds a chapter range; a book already waiting or downloading takes the
    /// wider range instead of a second job.
    pub fn enqueue(
        &self,
        book_id: &str,
        title: &str,
        start: u32,
        end: u32,
    ) -> Result<DownloadJob, AppError> {
        let (count, _) = self.inner.store.chapters(book_id)?;
        let end = end.min(count);
        if start >= end {
            return Err(AppError::invalid_argument("没有要缓存的章节"));
        }
        let job = {
            let mut jobs = lock(&self.inner.jobs);
            if let Some(job) = jobs.iter_mut().find(|job| {
                job.info.book_id == book_id
                    && matches!(
                        job.info.state,
                        DownloadState::Queued | DownloadState::Paused
                    )
            }) {
                job.info.start = job.info.start.min(start);
                job.info.end = job.info.end.max(end);
                job.info.total = job.info.end - job.info.start;
                job.info.state = DownloadState::Queued;
                job.info.clone()
            } else {
                let info = DownloadJob {
                    id: uuid::Uuid::new_v4().to_string(),
                    book_id: book_id.to_string(),
                    title: title.to_string(),
                    start,
                    end,
                    state: DownloadState::Queued,
                    cached: 0,
                    failed: 0,
                    total: end - start,
                    created_at: now_millis(),
                };
                jobs.push(Job {
                    info: info.clone(),
                    stop: Arc::new(AtomicBool::new(false)),
                });
                info
            }
        };
        self.changed(true);
        self.pump();
        Ok(job)
    }

    pub fn pause(&self, id: &str) {
        self.set_state(id, DownloadState::Paused);
    }

    pub fn cancel(&self, id: &str) {
        self.set_state(id, DownloadState::Cancelled);
    }

    pub fn resume(&self, id: &str) {
        {
            let mut jobs = lock(&self.inner.jobs);
            if let Some(job) = jobs.iter_mut().find(|job| job.info.id == id) {
                if matches!(
                    job.info.state,
                    DownloadState::Paused | DownloadState::Cancelled
                ) {
                    job.info.state = DownloadState::Queued;
                    job.info.failed = 0;
                }
            }
        }
        self.changed(true);
        self.pump();
    }

    /// The notification's 停止: every waiting and running job pauses.
    pub fn pause_all(&self) {
        let ids: Vec<String> = lock(&self.inner.jobs)
            .iter()
            .filter(|job| {
                matches!(
                    job.info.state,
                    DownloadState::Queued | DownloadState::Running
                )
            })
            .map(|job| job.info.id.clone())
            .collect();
        for id in ids {
            self.pause(&id);
        }
    }

    pub fn clear_finished(&self) {
        lock(&self.inner.jobs).retain(|job| {
            !matches!(
                job.info.state,
                DownloadState::Done | DownloadState::Cancelled
            )
        });
        self.changed(true);
    }

    /// Jobs of a deleted book go with it.
    pub fn forget_book(&self, book_id: &str) {
        let mut jobs = lock(&self.inner.jobs);
        for job in jobs.iter().filter(|job| job.info.book_id == book_id) {
            job.stop.store(true, Ordering::Release);
        }
        jobs.retain(|job| job.info.book_id != book_id);
        drop(jobs);
        self.changed(true);
    }

    fn set_state(&self, id: &str, state: DownloadState) {
        {
            let mut jobs = lock(&self.inner.jobs);
            let Some(job) = jobs.iter_mut().find(|job| job.info.id == id) else {
                return;
            };
            if matches!(job.info.state, DownloadState::Done) {
                return;
            }
            if job.info.state == DownloadState::Running {
                job.stop.store(true, Ordering::Release);
            }
            job.info.state = state;
        }
        self.changed(true);
        self.pump();
    }

    /// Persists the queue and tells the listener, at most every 250 ms unless forced.
    fn changed(&self, force: bool) {
        {
            let mut last = lock(&self.inner.last_emit);
            if !force && last.is_some_and(|at| at.elapsed() < EMIT_EVERY) {
                return;
            }
            *last = Some(Instant::now());
        }
        let jobs = self.list();
        if force {
            if let Some(path) = &self.inner.file {
                if let Ok(text) = serde_json::to_string(&jobs) {
                    let _ = std::fs::write(path, text);
                }
            }
        }
        (self.inner.listener)(&jobs);
    }

    /// Starts waiting jobs while fewer books than the limit are running.
    fn pump(&self) {
        let (books, _) = (self.inner.limits)();
        loop {
            let started = {
                let mut jobs = lock(&self.inner.jobs);
                let running = jobs
                    .iter()
                    .filter(|job| job.info.state == DownloadState::Running)
                    .count();
                if running >= books.max(1) {
                    return;
                }
                let Some(job) = jobs
                    .iter_mut()
                    .find(|job| job.info.state == DownloadState::Queued)
                else {
                    return;
                };
                job.info.state = DownloadState::Running;
                job.stop = Arc::new(AtomicBool::new(false));
                (job.info.id.clone(), job.stop.clone())
            };
            self.changed(true);
            let queue = self.clone();
            let (id, stop) = started;
            let spawned = std::thread::Builder::new()
                .name("download".into())
                .stack_size(ENGINE_STACK)
                .spawn(move || queue.run(&id, &stop));
            if spawned.is_err() {
                crate::app_log::warn("download", "下载线程启动失败");
                return;
            }
        }
    }

    fn update(&self, id: &str, change: impl FnOnce(&mut DownloadJob)) {
        if let Some(job) = lock(&self.inner.jobs)
            .iter_mut()
            .find(|job| job.info.id == id)
        {
            change(&mut job.info);
        }
    }

    fn run(&self, id: &str, stop: &AtomicBool) {
        let Some(job) = lock(&self.inner.jobs)
            .iter()
            .find(|job| job.info.id == id)
            .map(|job| job.info.clone())
        else {
            return;
        };
        let (_, per_book) = (self.inner.limits)();
        let planned = self.inner.store.chapters(&job.book_id);
        let (count, cached) = match planned {
            Ok(value) => value,
            Err(error) => {
                crate::app_log::warn(
                    "download",
                    format!("《{}》无法缓存：{}", job.title, error.message),
                );
                self.finish(id, stop);
                return;
            }
        };
        let end = job.end.min(count);
        let wanted: VecDeque<u32> = (job.start..end)
            .filter(|index| !cached.contains(index))
            .collect();
        let already = (job.start..end)
            .filter(|index| cached.contains(index))
            .count() as u32;
        self.update(id, |info| {
            info.end = end;
            info.total = end.saturating_sub(info.start);
            info.cached = already;
            info.failed = 0;
        });
        self.changed(true);
        let wanted = Mutex::new(wanted);
        std::thread::scope(|scope| {
            for _ in 0..per_book.max(1) {
                let builder = std::thread::Builder::new()
                    .name("download-chapter".into())
                    .stack_size(ENGINE_STACK);
                let _ = builder.spawn_scoped(scope, || loop {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    let Some(index) = lock(&wanted).pop_front() else {
                        return;
                    };
                    let mut fetched = false;
                    for _ in 0..ATTEMPTS {
                        if stop.load(Ordering::Acquire) {
                            return;
                        }
                        if self.inner.store.fetch(&job.book_id, index).is_ok() {
                            fetched = true;
                            break;
                        }
                    }
                    self.update(id, |info| {
                        if fetched {
                            info.cached += 1;
                        } else {
                            info.failed += 1;
                        }
                    });
                    self.changed(false);
                });
            }
        });
        self.finish(id, stop);
    }

    fn finish(&self, id: &str, stop: &AtomicBool) {
        self.update(id, |info| {
            // A pause or cancel already set the state; otherwise the range is done.
            if !stop.load(Ordering::Acquire) && info.state == DownloadState::Running {
                info.state = DownloadState::Done;
            }
        });
        self.changed(true);
        self.pump();
    }
}

/// The library as the queue sees it.
pub struct LibraryChapters(pub crate::online_reader::Shared);

impl ChapterStore for LibraryChapters {
    fn chapters(&self, book_id: &str) -> Result<(u32, BTreeSet<u32>), AppError> {
        let guard = self
            .0
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Database, "storage lock is poisoned"))?;
        Ok((
            guard.online_chapter_count(book_id)?,
            guard.cached_online_chapters(book_id)?.into_iter().collect(),
        ))
    }

    fn fetch(&self, book_id: &str, index: u32) -> Result<(), AppError> {
        crate::online_reader::raw_chapter(&self.0, book_id, index).map(|_| ())
    }
}

/// The Android foreground service and notification while jobs run.
pub fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-downloads")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "DownloadPlugin")?;
                _app.manage(DownloadPlugin(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg(target_os = "android")]
pub struct DownloadPlugin<R: tauri::Runtime>(pub tauri::plugin::PluginHandle<R>);

/// Shows, updates, or ends the notification for the jobs now in the queue.
pub fn notify<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, jobs: &[DownloadJob]) {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let Some(plugin) = _app.try_state::<DownloadPlugin<R>>() else {
            return;
        };
        let active: Vec<&DownloadJob> = jobs
            .iter()
            .filter(|job| matches!(job.state, DownloadState::Running | DownloadState::Queued))
            .collect();
        let payload = if let Some(first) = active
            .iter()
            .find(|job| job.state == DownloadState::Running)
            .or(active.first())
        {
            serde_json::json!({
                "active": true,
                "title": format!("正在缓存 {} 本", active.len()),
                "text": format!("{} {}/{}", first.title, first.cached + first.failed, first.total),
                "progress": first.cached + first.failed,
                "max": first.total,
            })
        } else {
            serde_json::json!({ "active": false })
        };
        let _ = plugin
            .0
            .run_mobile_plugin::<serde_json::Value>("update", payload);
    }
    #[cfg(not(target_os = "android"))]
    let _ = jobs;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// Chapters that take a moment each, counting how many are fetched at once.
    struct Slow {
        count: u32,
        cached: BTreeSet<u32>,
        now: AtomicUsize,
        most: AtomicUsize,
        fetched: Mutex<Vec<u32>>,
        fail: Option<u32>,
    }

    impl ChapterStore for Slow {
        fn chapters(&self, _: &str) -> Result<(u32, BTreeSet<u32>), AppError> {
            let mut cached = self.cached.clone();
            cached.extend(lock(&self.fetched).iter().copied());
            Ok((self.count, cached))
        }

        fn fetch(&self, _: &str, index: u32) -> Result<(), AppError> {
            let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(15));
            self.now.fetch_sub(1, Ordering::SeqCst);
            if self.fail == Some(index) {
                return Err(AppError::invalid_argument("失败"));
            }
            lock(&self.fetched).push(index);
            Ok(())
        }
    }

    fn slow(count: u32, cached: &[u32], fail: Option<u32>) -> Arc<Slow> {
        Arc::new(Slow {
            count,
            cached: cached.iter().copied().collect(),
            now: AtomicUsize::new(0),
            most: AtomicUsize::new(0),
            fetched: Mutex::new(Vec::new()),
            fail,
        })
    }

    fn queue(store: Arc<Slow>, file: Option<PathBuf>) -> Downloads {
        Downloads::new(store, Arc::new(|| (1, 4)), Arc::new(|_| {}), file)
    }

    fn wait_for(queue: &Downloads, done: impl Fn(&[DownloadJob]) -> bool) -> Vec<DownloadJob> {
        let started = Instant::now();
        loop {
            let jobs = queue.list();
            if done(&jobs) || started.elapsed() > Duration::from_secs(10) {
                return jobs;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn fetches_chapters_concurrently_and_skips_kept_ones() {
        let store = slow(20, &[0, 1], Some(5));
        let downloads = queue(store.clone(), None);
        downloads.enqueue("a", "甲书", 0, 50).unwrap();
        let jobs = wait_for(&downloads, |jobs| jobs[0].state == DownloadState::Done);
        assert_eq!(jobs[0].state, DownloadState::Done);
        assert_eq!((jobs[0].cached, jobs[0].failed, jobs[0].total), (19, 1, 20));
        let most = store.most.load(Ordering::SeqCst);
        assert!(most > 1 && most <= 4, "{most} at once");
        assert!(!lock(&store.fetched).contains(&0));
    }

    #[test]
    fn books_wait_their_turn_and_pause_resume_and_persist() {
        let dir = std::env::temp_dir().join(format!("gripread-downloads-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("downloads.json");
        let store = slow(40, &[], None);
        let downloads = queue(store.clone(), Some(file.clone()));
        let first = downloads.enqueue("a", "甲书", 0, 40).unwrap();
        let second = downloads.enqueue("b", "乙书", 0, 40).unwrap();
        // One book at a time: the second waits.
        assert_eq!(downloads.list()[1].state, DownloadState::Queued);
        downloads.pause(&first.id);
        let jobs = wait_for(&downloads, |jobs| jobs[1].state == DownloadState::Running);
        assert_eq!(jobs[0].state, DownloadState::Paused);
        downloads.cancel(&second.id);
        wait_for(&downloads, |jobs| jobs[1].state == DownloadState::Cancelled);
        std::thread::sleep(Duration::from_millis(60));

        // After a restart the paused job is still there, and resumes.
        let reopened = queue(store, Some(file));
        assert_eq!(reopened.list()[0].state, DownloadState::Paused);
        reopened.resume(&first.id);
        let jobs = wait_for(&reopened, |jobs| jobs[0].state == DownloadState::Done);
        assert_eq!(jobs[0].cached, 40);
        reopened.clear_finished();
        assert!(reopened.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
