//! 书源订阅: addresses of source lists the reader imports from again by hand.
//! Updating one runs the ordinary 网络导入 preview on its address; the
//! list is kept in the data folder only (`source-subscriptions.json`),
//! not in backups or sync, like 网络设置.

use std::fs;
use std::path::Path;
use std::sync::Arc;

use crate::commands::AppState;
use crate::error::AppError;
use crate::models::{SourceSubscription, SubscriptionImportedRequest, SubscriptionRequest};

const FILE: &str = "source-subscriptions.json";

pub fn load(root: &Path) -> Vec<SourceSubscription> {
    fs::read_to_string(root.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(root: &Path, list: &[SourceSubscription]) -> Result<(), AppError> {
    let path = root.join(FILE);
    let partial = path.with_extension("json.part");
    fs::write(&partial, serde_json::to_string_pretty(list)?)?;
    fs::rename(&partial, &path)?;
    Ok(())
}

/// Adds a subscription, or renames and readdresses one with the same id.
/// An address already subscribed keeps its one entry.
pub fn put(
    root: &Path,
    subscription: SourceSubscription,
) -> Result<Vec<SourceSubscription>, AppError> {
    let url = subscription.url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(AppError::keyed(
            crate::error::ErrorCode::InvalidArgument,
            "subscriptionAddress",
            "订阅地址需要以 http:// 或 https:// 开头",
        ));
    }
    let mut list = load(root);
    let name = match subscription.name.trim() {
        "" => crate::sources::http::host_of(&url),
        name => name.to_string(),
    };
    let same = |item: &SourceSubscription| {
        (!subscription.id.is_empty() && item.id == subscription.id) || item.url == url
    };
    match list.iter_mut().find(|item| same(item)) {
        Some(item) => {
            item.name = name;
            item.url = url;
        }
        None => list.push(SourceSubscription {
            id: if subscription.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                subscription.id
            },
            name,
            url,
            updated_at: None,
            imported: None,
        }),
    }
    save(root, &list)?;
    Ok(list)
}

pub fn remove(root: &Path, id: &str) -> Result<Vec<SourceSubscription>, AppError> {
    let mut list = load(root);
    list.retain(|item| item.id != id);
    save(root, &list)?;
    Ok(list)
}

/// Notes an update: when, and how many sources it imported.
pub fn imported(root: &Path, id: &str, count: u32) -> Result<Vec<SourceSubscription>, AppError> {
    let mut list = load(root);
    if let Some(item) = list.iter_mut().find(|item| item.id == id) {
        item.updated_at = Some(crate::cloud::now_millis());
        item.imported = Some(count);
    }
    save(root, &list)?;
    Ok(list)
}

pub async fn list_source_subscriptions(
    state: &Arc<AppState>,
) -> Result<Vec<SourceSubscription>, AppError> {
    Ok(load(&state.data_root))
}

pub async fn save_source_subscription(
    state: &Arc<AppState>,
    request: SourceSubscription,
) -> Result<Vec<SourceSubscription>, AppError> {
    put(&state.data_root, request)
}

pub async fn delete_source_subscription(
    state: &Arc<AppState>,
    request: SubscriptionRequest,
) -> Result<Vec<SourceSubscription>, AppError> {
    remove(&state.data_root, &request.id)
}

pub async fn source_subscription_imported(
    state: &Arc<AppState>,
    request: SubscriptionImportedRequest,
) -> Result<Vec<SourceSubscription>, AppError> {
    imported(&state.data_root, &request.id, request.count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscriptions_are_kept_once_per_address_with_their_last_update() {
        let root = std::env::temp_dir().join(format!("gripread-subs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let entry = |name: &str, url: &str| SourceSubscription {
            id: String::new(),
            name: name.into(),
            url: url.into(),
            updated_at: None,
            imported: None,
        };
        let list = put(&root, entry("", "https://a.example/sources.json")).unwrap();
        assert_eq!(list[0].name, "a.example");
        // The same address again renames the one entry.
        let list = put(&root, entry("常用", " https://a.example/sources.json ")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "常用");
        assert!(put(&root, entry("坏", "ftp://x")).is_err());
        let id = list[0].id.clone();
        let list = imported(&root, &id, 12).unwrap();
        assert_eq!(list[0].imported, Some(12));
        assert!(list[0].updated_at.is_some());
        assert!(remove(&root, &id).unwrap().is_empty());
        fs::remove_dir_all(&root).unwrap();
    }
}
