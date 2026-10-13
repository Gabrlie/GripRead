//! The server's single account: a password (argon2) set on first run or by
//! `GRIPREAD_PASSWORD`, and sessions, one per signed-in device or browser,
//! each a random token kept only as its SHA-256. Both live in `server.json`
//! in the data folder, apart from the library and never in backups.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FILE: &str = "server.json";
/// Failed sign-ins allowed within [`FAILURE_WINDOW`] before more are refused.
const FAILURES_ALLOWED: usize = 5;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
/// How often a session's last-seen time is written back.
const SEEN_EVERY_MS: i64 = 10 * 60_000;
pub const MIN_PASSWORD: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    token_hash: String,
    pub device: String,
    pub created_at: i64,
    pub last_seen: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    password: Option<String>,
    sessions: Vec<Session>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    /// The password is already set (setup), or not yet (login).
    WrongState,
    BadPassword,
    TooMany,
    TooShort,
    Io(String),
}

pub struct Auth {
    path: PathBuf,
    stored: Mutex<Stored>,
    failures: Mutex<VecDeque<Instant>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

fn digest(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn hash_password(password: &str) -> Result<String, AuthError> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
        .map_err(|error| AuthError::Io(error.to_string()))
}

impl Auth {
    /// Loads `server.json`; `initial` sets the password when none is stored.
    pub fn open(root: &Path, initial: Option<&str>) -> Result<Self, AuthError> {
        let path = root.join(FILE);
        let stored = match std::fs::read_to_string(&path) {
            Ok(text) => {
                serde_json::from_str(&text).map_err(|error| AuthError::Io(error.to_string()))?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Stored::default(),
            Err(error) => return Err(AuthError::Io(error.to_string())),
        };
        let auth = Self {
            path,
            stored: Mutex::new(stored),
            failures: Mutex::new(VecDeque::new()),
        };
        if let Some(password) = initial.filter(|password| !password.is_empty()) {
            if !auth.configured() {
                if password.chars().count() < MIN_PASSWORD {
                    return Err(AuthError::TooShort);
                }
                let mut stored = auth.lock();
                stored.password = Some(hash_password(password)?);
                auth.save(&stored)?;
            }
        }
        Ok(auth)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Stored> {
        self.stored
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn save(&self, stored: &Stored) -> Result<(), AuthError> {
        let text = serde_json::to_string_pretty(stored)
            .map_err(|error| AuthError::Io(error.to_string()))?;
        let partial = self.path.with_extension("json.part");
        std::fs::write(&partial, text)
            .and_then(|()| std::fs::rename(&partial, &self.path))
            .map_err(|error| AuthError::Io(error.to_string()))
    }

    pub fn configured(&self) -> bool {
        self.lock().password.is_some()
    }

    fn new_session(&self, stored: &mut Stored, device: &str) -> Result<String, AuthError> {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let now = now_ms();
        let device: String = device.trim().chars().take(60).collect();
        stored.sessions.push(Session {
            id: uuid::Uuid::new_v4().to_string(),
            token_hash: digest(&token),
            device: if device.is_empty() {
                "未命名设备".into()
            } else {
                device
            },
            created_at: now,
            last_seen: now,
        });
        self.save(stored)?;
        Ok(token)
    }

    /// 设置密码 on first run; signs this device in.
    pub fn setup(&self, password: &str, device: &str) -> Result<String, AuthError> {
        let mut stored = self.lock();
        if stored.password.is_some() {
            return Err(AuthError::WrongState);
        }
        if password.chars().count() < MIN_PASSWORD {
            return Err(AuthError::TooShort);
        }
        stored.password = Some(hash_password(password)?);
        self.new_session(&mut stored, device)
    }

    /// Signs a device in, refusing for a minute after repeated failures.
    pub fn login(&self, password: &str, device: &str) -> Result<String, AuthError> {
        {
            let mut failures = self
                .failures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while failures
                .front()
                .is_some_and(|at| at.elapsed() >= FAILURE_WINDOW)
            {
                failures.pop_front();
            }
            if failures.len() >= FAILURES_ALLOWED {
                return Err(AuthError::TooMany);
            }
        }
        let mut stored = self.lock();
        let Some(hash) = stored.password.clone() else {
            return Err(AuthError::WrongState);
        };
        let matches = PasswordHash::new(&hash)
            .map(|parsed| {
                Argon2::default()
                    .verify_password(password.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false);
        if !matches {
            self.failures
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push_back(Instant::now());
            return Err(AuthError::BadPassword);
        }
        self.new_session(&mut stored, device)
    }

    /// The session a token belongs to, noting that it was seen.
    pub fn session(&self, token: &str) -> Option<Session> {
        let hash = digest(token);
        let mut stored = self.lock();
        let now = now_ms();
        let session = stored
            .sessions
            .iter_mut()
            .find(|session| session.token_hash == hash)?;
        let stale = now - session.last_seen >= SEEN_EVERY_MS;
        session.last_seen = now;
        let found = session.clone();
        if stale {
            let _ = self.save(&stored);
        }
        Some(found)
    }

    pub fn sessions(&self) -> Vec<Session> {
        let mut sessions: Vec<Session> = self
            .lock()
            .sessions
            .iter()
            .map(|session| Session {
                token_hash: String::new(),
                ..session.clone()
            })
            .collect();
        sessions.sort_by_key(|session| std::cmp::Reverse(session.last_seen));
        sessions
    }

    /// Signs a session out; `false` when there was none with that id.
    pub fn revoke(&self, id: &str) -> Result<bool, AuthError> {
        let mut stored = self.lock();
        let before = stored.sessions.len();
        stored.sessions.retain(|session| session.id != id);
        if stored.sessions.len() == before {
            return Ok(false);
        }
        self.save(&stored)?;
        Ok(true)
    }

    /// 修改密码: every other session is signed out.
    pub fn change_password(&self, current: &str, next: &str, keep: &str) -> Result<(), AuthError> {
        if next.chars().count() < MIN_PASSWORD {
            return Err(AuthError::TooShort);
        }
        let mut stored = self.lock();
        let hash = stored.password.clone().ok_or(AuthError::WrongState)?;
        let matches = PasswordHash::new(&hash)
            .map(|parsed| {
                Argon2::default()
                    .verify_password(current.as_bytes(), &parsed)
                    .is_ok()
            })
            .unwrap_or(false);
        if !matches {
            return Err(AuthError::BadPassword);
        }
        stored.password = Some(hash_password(next)?);
        stored.sessions.retain(|session| session.id == keep);
        self.save(&stored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("gripread-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn first_run_sets_the_password_and_sessions_follow_tokens() {
        let root = root();
        let auth = Auth::open(&root, None).unwrap();
        assert!(!auth.configured());
        assert_eq!(auth.login("secret1", "手机"), Err(AuthError::WrongState));
        assert_eq!(auth.setup("short", "手机"), Err(AuthError::TooShort));
        let token = auth.setup("secret1", "手机").unwrap();
        assert_eq!(auth.setup("secret2", "手机"), Err(AuthError::WrongState));
        assert_eq!(auth.session(&token).unwrap().device, "手机");
        assert!(auth.session("forged").is_none());

        // Stored tokens are hashes only, and the account survives a restart.
        let text = std::fs::read_to_string(root.join(FILE)).unwrap();
        assert!(!text.contains(&token));
        let again = Auth::open(&root, Some("ignored-because-set")).unwrap();
        assert!(again.session(&token).is_some());
        let browser = again.login("secret1", "").unwrap();
        assert_eq!(again.sessions().len(), 2);
        assert!(again
            .sessions()
            .iter()
            .all(|session| session.token_hash.is_empty()));
        let id = again.session(&browser).unwrap().id;
        assert!(again.revoke(&id).unwrap());
        assert!(again.session(&browser).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_failures_are_refused_for_a_while() {
        let root = root();
        let auth = Auth::open(&root, Some("secret1")).unwrap();
        for _ in 0..FAILURES_ALLOWED {
            assert_eq!(auth.login("wrong", "x"), Err(AuthError::BadPassword));
        }
        assert_eq!(auth.login("secret1", "x"), Err(AuthError::TooMany));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_new_password_signs_other_devices_out() {
        let root = root();
        let auth = Auth::open(&root, Some("secret1")).unwrap();
        let mine = auth.login("secret1", "电脑").unwrap();
        let other = auth.login("secret1", "手机").unwrap();
        let keep = auth.session(&mine).unwrap().id;
        assert_eq!(
            auth.change_password("wrong", "secret2", &keep),
            Err(AuthError::BadPassword)
        );
        auth.change_password("secret1", "secret2", &keep).unwrap();
        assert!(auth.session(&mine).is_some());
        assert!(auth.session(&other).is_none());
        assert!(auth.login("secret2", "手机").is_ok());
        let _ = std::fs::remove_dir_all(root);
    }
}
