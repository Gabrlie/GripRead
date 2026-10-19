//! Private groups: a shelf group whose books are left out of other lists
//! until it is opened, by a tap on its mask or by its password, and that
//! may keep its books out of sync and backups. The password is kept as an
//! argon2 hash and checked here; it hides books, it does not encrypt them.

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, SaltString};
use argon2::{Argon2, PasswordVerifier};

use super::*;
use crate::models::{GroupLock, GroupPrivacy, SaveGroupPrivacyRequest};

/// A group's privacy as stored: its settings and password hash.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct StoredPrivacy {
    pub privacy: Option<GroupPrivacy>,
    pub password_hash: Option<String>,
}

/// What logs and job reports call a book in a private group.
pub const PRIVATE_TITLE: &str = "隐私书籍";

const PASSWORD_CHARS: std::ops::RangeInclusive<usize> = 4..=64;

pub(crate) fn hash_password(password: &str) -> Result<String, AppError> {
    Argon2::default()
        .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::new(ErrorCode::Io, format!("password hash failed: {error}")))
}

pub(crate) fn password_matches(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    })
}

pub(crate) fn lock_name(lock: GroupLock) -> &'static str {
    match lock {
        GroupLock::Mask => "mask",
        GroupLock::Password => "password",
    }
}

pub(crate) fn parse_lock(name: &str) -> GroupLock {
    if name == "password" {
        GroupLock::Password
    } else {
        GroupLock::Mask
    }
}

fn bad_password() -> AppError {
    AppError::keyed(ErrorCode::InvalidArgument, "badPassword", "密码不对")
}

impl Storage {
    pub(crate) fn group_privacy(&self, id: &str) -> Result<StoredPrivacy, AppError> {
        let row: Option<(bool, Option<String>, Option<String>, bool)> = self
            .conn
            .query_row(
                "SELECT private, lock, password_hash, sync FROM library_groups WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((private, lock, password_hash, sync)) = row else {
            return Err(AppError::new(
                ErrorCode::NotFound,
                "library group was not found",
            ));
        };
        Ok(StoredPrivacy {
            privacy: private.then(|| GroupPrivacy {
                lock: parse_lock(lock.as_deref().unwrap_or_default()),
                sync,
            }),
            password_hash,
        })
    }

    pub(crate) fn write_group_privacy(
        &self,
        id: &str,
        stored: &StoredPrivacy,
    ) -> Result<(), AppError> {
        let privacy = stored.privacy.as_ref();
        self.conn.execute(
            "UPDATE library_groups SET private = ?2, lock = ?3, password_hash = ?4, sync = ?5
             WHERE id = ?1",
            params![
                id,
                privacy.is_some(),
                privacy.map(|privacy| lock_name(privacy.lock)),
                stored.password_hash,
                privacy.is_none_or(|privacy| privacy.sync)
            ],
        )?;
        Ok(())
    }

    /// Checks a password group's password; any other group needs none.
    pub(crate) fn check_group_password(
        &self,
        id: &str,
        password: Option<&str>,
    ) -> Result<(), AppError> {
        match self.group_privacy(id)?.password_hash {
            Some(hash) if !password.is_some_and(|password| password_matches(&hash, password)) => {
                Err(bad_password())
            }
            _ => Ok(()),
        }
    }

    /// Makes a group private, changes its lock or password, or makes it
    /// ordinary again. Changing a password group needs its password.
    pub fn save_group_privacy(
        &self,
        request: &SaveGroupPrivacyRequest,
    ) -> Result<LibraryGroup, AppError> {
        self.check_group_password(&request.id, request.current_password.as_deref())?;
        let current = self.group_privacy(&request.id)?;
        let password_hash = match &request.privacy {
            Some(privacy) if privacy.lock == GroupLock::Password => match &request.password {
                Some(password) => {
                    if !PASSWORD_CHARS.contains(&password.chars().count()) {
                        return Err(AppError::keyed(
                            ErrorCode::InvalidArgument,
                            "groupPasswordLength",
                            "密码需要 4 到 64 个字符",
                        ));
                    }
                    Some(hash_password(password)?)
                }
                None => Some(current.password_hash.ok_or_else(|| {
                    AppError::keyed(
                        ErrorCode::InvalidArgument,
                        "groupPasswordMissing",
                        "请设置密码",
                    )
                })?),
            },
            _ => None,
        };
        self.write_group_privacy(
            &request.id,
            &StoredPrivacy {
                privacy: request.privacy.clone(),
                password_hash,
            },
        )?;
        self.list_groups()?
            .into_iter()
            .find(|group| group.id == request.id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "library group was not found"))
    }

    /// Opens a password group; a wrong password is an error.
    pub fn unlock_group(&self, id: &str, password: &str) -> Result<(), AppError> {
        self.check_group_password(id, Some(password))
    }
}

impl Storage {
    /// Books in private groups, and of those the ones whose group keeps
    /// them out of sync and backups.
    pub(crate) fn private_books(
        &self,
    ) -> Result<
        (
            std::collections::HashSet<String>,
            std::collections::HashSet<String>,
        ),
        AppError,
    > {
        let mut statement = self.conn.prepare(
            "SELECT m.book_id, g.sync FROM book_groups m
             JOIN library_groups g ON g.id = m.group_id WHERE g.private = 1",
        )?;
        let mut private = std::collections::HashSet::new();
        let mut unsynced = std::collections::HashSet::new();
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?))
        })? {
            let (book_id, sync) = row?;
            if !sync {
                unsynced.insert(book_id.clone());
            }
            private.insert(book_id);
        }
        Ok((private, unsynced))
    }

    /// Books in private groups.
    pub fn private_book_ids(&self) -> Result<std::collections::HashSet<String>, AppError> {
        Ok(self.private_books()?.0)
    }

    /// How logs name a book: a book in a private group only as such.
    pub fn log_title(&self, book_id: &str, title: &str) -> String {
        if self.is_private_book(book_id).unwrap_or(false) {
            PRIVATE_TITLE.to_string()
        } else {
            title.to_string()
        }
    }

    /// Whether a book's private group keeps it out of sync and backups.
    pub fn keeps_book_private(&self, book_id: &str) -> Result<bool, AppError> {
        Ok(self.private_books()?.1.contains(book_id))
    }

    /// Whether a book is in a private group (the server does not update
    /// it on schedule or name it in logs).
    pub fn is_private_book(&self, book_id: &str) -> Result<bool, AppError> {
        Ok(self.private_books()?.0.contains(book_id))
    }

    /// A group's privacy as a sync or backup record: absent for an
    /// ordinary group, with the password hash so every device opens it alike.
    pub(crate) fn privacy_record(&self, id: &str) -> Result<serde_json::Value, AppError> {
        let stored = self.group_privacy(id)?;
        Ok(match stored.privacy {
            None => serde_json::Value::Bool(false),
            Some(privacy) => serde_json::json!({
                "lock": lock_name(privacy.lock),
                "sync": privacy.sync,
                "passwordHash": stored.password_hash,
            }),
        })
    }

    /// Applies a group's privacy from a sync or backup record.
    pub(crate) fn apply_privacy_record(
        &self,
        id: &str,
        record: &serde_json::Value,
    ) -> Result<(), AppError> {
        let stored = match record.as_object() {
            Some(fields) => StoredPrivacy {
                privacy: Some(GroupPrivacy {
                    lock: parse_lock(fields.get("lock").and_then(|v| v.as_str()).unwrap_or("")),
                    sync: fields.get("sync").and_then(|v| v.as_bool()).unwrap_or(true),
                }),
                password_hash: fields
                    .get("passwordHash")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            },
            None => StoredPrivacy::default(),
        };
        self.write_group_privacy(id, &stored)
    }
}
