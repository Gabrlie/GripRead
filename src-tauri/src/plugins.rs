//! The app's side of the core's platform interfaces: Tauri events, and on
//! Android the Kotlin plugins in `gen/android` (`DocumentPlugin`,
//! `DownloadPlugin`, `NetworkPlugin`, `UpdatePlugin`) behind [`Platform`];
//! on macOS the Tauri updater.

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
impl<R: Runtime> gripread_core::platform::Platform for AppPlatform<R> {
    /// Releases carry macOS builds only.
    fn update_target(&self) -> gripread_core::platform::UpdateTarget {
        use gripread_core::platform::UpdateTarget;
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", "aarch64") => UpdateTarget::Desktop {
                platform: "darwin-aarch64".into(),
            },
            ("macos", "x86_64") => UpdateTarget::Desktop {
                platform: "darwin-x86_64".into(),
            },
            _ => UpdateTarget::None,
        }
    }

    fn install_desktop_update(
        &self,
        request: &gripread_core::platform::DesktopUpdate,
        progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    ) -> Result<(), gripread_core::error::AppError> {
        use gripread_core::error::{AppError, ErrorCode};
        use tauri_plugin_updater::UpdaterExt;
        let failed = |error: tauri_plugin_updater::Error| {
            AppError::new(ErrorCode::Io, format!("更新失败：{error}"))
        };
        fn invalid(error: impl std::fmt::Display) -> AppError {
            AppError::new(ErrorCode::InvalidArgument, format!("更新地址无效：{error}"))
        }
        let mut builder = self
            .0
            .updater_builder()
            .endpoints(vec![tauri::Url::parse(&request.manifest).map_err(invalid)?])
            .map_err(failed)?;
        if let Some(authorization) = &request.authorization {
            builder = builder
                .header("Authorization", authorization.as_str())
                .map_err(failed)?;
        }
        if let Some(proxy) = &request.proxy {
            builder = builder.proxy(tauri::Url::parse(proxy).map_err(invalid)?);
        }
        let updater = builder.build().map_err(failed)?;
        tauri::async_runtime::block_on(async {
            let mut update = updater
                .check()
                .await
                .map_err(failed)?
                .ok_or_else(|| AppError::new(ErrorCode::Io, "已经是最新版本"))?;
            // The manifest names GitHub's archive; the chosen route has its own.
            let name = update
                .download_url
                .path_segments()
                .and_then(|mut segments| segments.next_back())
                .unwrap_or_default()
                .to_string();
            if let Some(address) = (request.archive)(&name) {
                update.download_url = tauri::Url::parse(&address).map_err(invalid)?;
            }
            let mut received = 0u64;
            update
                .download_and_install(
                    |chunk, total| {
                        received += chunk as u64;
                        progress(received, total);
                    },
                    || {},
                )
                .await
                .map_err(failed)
        })?;
        // Through the exit handshake, so the page saves first.
        self.0.request_restart();
        Ok(())
    }
}

#[cfg(target_os = "android")]
pub use android::*;

#[cfg(target_os = "android")]
mod android {
    use super::AppPlatform;
    use gripread_core::error::{AppError, ErrorCode};
    use gripread_core::models::{DownloadJob, InstallOutcome, PickedFile};
    use gripread_core::platform::{Platform, UpdateTarget};
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::FromRawFd;
    use tauri::{Manager, Runtime};

    pub struct DocumentPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);
    pub struct DownloadPlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);
    pub struct UpdatePlugin<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

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
        fn update_target(&self) -> UpdateTarget {
            #[derive(serde::Deserialize)]
            struct Info {
                abis: Vec<String>,
                folder: String,
            }
            let Some(plugin) = self.0.try_state::<UpdatePlugin<R>>() else {
                return UpdateTarget::None;
            };
            match plugin
                .0
                .run_mobile_plugin::<Info>("info", serde_json::json!({}))
            {
                Ok(info) => UpdateTarget::Android {
                    abis: info.abis,
                    folder: info.folder.into(),
                },
                Err(_) => UpdateTarget::None,
            }
        }

        fn install_apk(&self, file: &std::path::Path) -> Result<InstallOutcome, AppError> {
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Response {
                needs_permission: bool,
            }
            let plugin = self
                .0
                .try_state::<UpdatePlugin<R>>()
                .ok_or_else(|| AppError::new(ErrorCode::Io, "安装程序不可用"))?;
            let response: Response = plugin
                .0
                .run_mobile_plugin(
                    "install",
                    serde_json::json!({ "path": file.to_string_lossy() }),
                )
                .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))?;
            Ok(if response.needs_permission {
                InstallOutcome::NeedsPermission
            } else {
                InstallOutcome::Started
            })
        }

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

/// Registers the Android update helper (`UpdatePlugin.kt`).
pub fn updates<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("gripread-updates")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin("com.gripread.reader", "UpdatePlugin")?;
                _app.manage(UpdatePlugin(handle));
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
                #[derive(serde::Deserialize)]
                struct Metered {
                    metered: bool,
                }
                let handle =
                    _api.register_android_plugin("com.gripread.reader", "NetworkPlugin")?;
                let asking = handle.clone();
                gripread_core::network::set_metered_detector(Box::new(move || {
                    asking
                        .run_mobile_plugin::<Metered>("metered", serde_json::json!({}))
                        .map(|answer| answer.metered)
                        .unwrap_or(false)
                }));
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
