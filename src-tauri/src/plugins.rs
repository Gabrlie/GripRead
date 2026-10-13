//! The app's side of the core's platform interfaces: Tauri events, and on
//! Android the Kotlin plugins in `gen/android` (`DocumentPlugin`,
//! `DownloadPlugin`, `NetworkPlugin`) behind [`Platform`].

use gripread_core::api::Events;
use tauri::{AppHandle, Emitter, Runtime};

/// Core events as Tauri events.
pub struct TauriEvents<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> Events for TauriEvents<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        if let Err(error) = self.0.emit(event, payload) {
            eprintln!("Unable to emit {event}: {error}");
        }
    }
}

/// Plain paths on desktop; Android documents, folders, and the download
/// notification through the Kotlin plugins.
pub struct AppPlatform<R: Runtime>(#[allow(dead_code)] pub AppHandle<R>);

#[cfg(not(target_os = "android"))]
impl<R: Runtime> gripread_core::platform::Platform for AppPlatform<R> {}

#[cfg(target_os = "android")]
pub use android::*;

#[cfg(target_os = "android")]
mod android {
    use super::AppPlatform;
    use gripread_core::error::{AppError, ErrorCode};
    use gripread_core::models::{DownloadJob, PickedFile};
    use gripread_core::platform::Platform;
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::FromRawFd;
    use tauri::{Manager, Runtime};

    pub struct DocumentPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);
    pub struct DownloadPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

    impl<R: Runtime> AppPlatform<R> {
        fn documents<T: serde::de::DeserializeOwned>(
            &self,
            command: &str,
            payload: serde_json::Value,
            code: ErrorCode,
        ) -> Result<T, AppError> {
            let plugin = self.0.state::<DocumentPlugin<R>>();
            plugin
                .0
                .run_mobile_plugin(command, payload)
                .map_err(|error| AppError::new(code, error.to_string()))
        }
    }

    /// A descriptor the Kotlin plugin detached and handed over.
    fn adopt(fd: i32) -> File {
        // SAFETY: the Kotlin plugin detaches the descriptor and transfers its
        // ownership to this process; it is closed when the File is dropped.
        unsafe { File::from_raw_fd(fd) }
    }

    impl<R: Runtime> Platform for AppPlatform<R> {
        fn downloads_changed(&self, jobs: &[DownloadJob]) {
            if let Some(plugin) = self.0.try_state::<DownloadPlugin<R>>() {
                let _ = plugin.0.run_mobile_plugin::<serde_json::Value>(
                    "update",
                    gripread_core::downloads::notification(jobs),
                );
            }
        }

        fn open_document(&self, uri: &str) -> Result<(File, Option<String>), AppError> {
            #[derive(serde::Deserialize)]
            struct Response {
                fd: i32,
                name: Option<String>,
            }
            let response: Response = self.documents(
                "openDocument",
                serde_json::json!({ "uri": uri }),
                ErrorCode::FileNotFound,
            )?;
            Ok((adopt(response.fd), response.name))
        }

        fn list_txt_folder(&self, _path: &str) -> Result<Vec<PickedFile>, AppError> {
            #[derive(serde::Deserialize)]
            struct Response {
                files: Vec<PickedFile>,
            }
            let response: Response =
                self.documents("pickFolder", serde_json::json!({}), ErrorCode::FileNotFound)?;
            Ok(response.files)
        }

        fn save_document(
            &self,
            _path: Option<&str>,
            name: &str,
            mime: &str,
            bytes: &[u8],
        ) -> Result<bool, AppError> {
            #[derive(serde::Deserialize)]
            struct Response {
                fd: Option<i32>,
            }
            let response: Response = self.documents(
                "createDocument",
                serde_json::json!({ "name": name, "mime": mime }),
                ErrorCode::InvalidPath,
            )?;
            let Some(fd) = response.fd else {
                return Ok(false);
            };
            let mut file = adopt(fd);
            file.write_all(bytes)?;
            file.sync_all()?;
            Ok(true)
        }

        fn open_tree_document(&self, tree: &str, name: &str, mime: &str) -> Result<File, AppError> {
            #[derive(serde::Deserialize)]
            struct Response {
                fd: i32,
            }
            let response: Response = self.documents(
                "openTreeDocument",
                serde_json::json!({ "tree": tree, "name": name, "mime": mime }),
                ErrorCode::InvalidPath,
            )?;
            Ok(adopt(response.fd))
        }

        fn pick_writable_folder(
            &self,
            _path: Option<&str>,
        ) -> Result<Option<(String, String)>, AppError> {
            #[derive(serde::Deserialize)]
            struct Response {
                uri: Option<String>,
                name: Option<String>,
            }
            let response: Response = self.documents(
                "pickWritableFolder",
                serde_json::json!({}),
                ErrorCode::InvalidPath,
            )?;
            Ok(response.uri.map(|uri| {
                let label = response.name.unwrap_or_else(|| uri.clone());
                (uri, label)
            }))
        }
    }
}

/// Registers the Android document helper (`DocumentPlugin.kt`).
pub fn documents<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-documents")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "DocumentPlugin")?;
                _app.manage(DocumentPlugin(handle));
            }
            Ok(())
        })
        .build()
}

/// The Android foreground service and notification while jobs run.
pub fn downloads<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
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

/// Registers the Android plugin that reports the device's proxy.
pub fn network<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-network")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                #[derive(serde::Deserialize)]
                struct Found {
                    host: Option<String>,
                    port: Option<u16>,
                }
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "NetworkPlugin")?;
                gripread_core::network::set_detector(Box::new(move || {
                    let found: Found = handle
                        .run_mobile_plugin("systemProxy", serde_json::json!({}))
                        .ok()?;
                    Some(format!("{}:{}", found.host?, found.port?))
                }));
            }
            Ok(())
        })
        .build()
}
