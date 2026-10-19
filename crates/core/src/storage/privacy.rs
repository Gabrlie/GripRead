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
