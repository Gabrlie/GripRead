//! The Tauri app: the core's commands behind one `rpc` command, its events
//! as Tauri events, and the platform plugins (documents, downloads, network,
//! and the WebView for sources).

mod plugins;
mod webview;

use gripread_core::api::{self, Reply};
use gripread_core::commands::AppState;
use gripread_core::error::{AppError, ErrorCode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::{Emitter, Manager};

/// The core's state, opened after the window: the WebView can call `rpc`
/// before opening (and upgrading the database) has finished.
struct Core(tokio::sync::watch::Sender<Option<Result<Arc<AppState>, AppError>>>);

impl Default for Core {
    fn default() -> Self {
        Self(tokio::sync::watch::channel(None).0)
    }
}

impl Core {
    /// The state once it is open.
    fn get(&self) -> Option<Arc<AppState>> {
        self.0
            .borrow()
            .as_ref()
            .and_then(|state| state.as_ref().ok().cloned())
    }

    /// Waits until the state is open, or has failed to open.
    async fn ready(&self) -> Result<Arc<AppState>, AppError> {
        let mut opened = self.0.subscribe();
        let state = opened
            .wait_for(Option::is_some)
            .await
            .map_err(|_| AppError::new(ErrorCode::Io, "应用数据没有打开"))?;
        state.clone().expect("waited for the state")
    }
}

/// Runs a core command by name (see `gripread_core::api`).
#[tauri::command]
async fn rpc(
    name: String,
    args: Option<serde_json::Value>,
    core: tauri::State<'_, Core>,
) -> Result<Response, AppError> {
    let state = core.ready().await?;
    let reply = api::dispatch(&state, &name, args.unwrap_or(serde_json::Value::Null)).await?;
    Ok(Response::new(match reply {
        Reply::Json(value) => InvokeResponseBody::Json(value.to_string()),
        Reply::Bytes(bytes) => InvokeResponseBody::Raw(bytes),
    }))
}

#[derive(Default)]
struct ExitPermission(AtomicBool);

#[tauri::command]
fn complete_exit(app: tauri::AppHandle) {
    app.state::<ExitPermission>()
        .0
        .store(true, Ordering::Release);
    app.exit(0);
}

/// Starts the same ordered-save exit handshake as native Quit (Android back at the root).
#[tauri::command]
fn request_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(plugins::documents())
        .plugin(plugins::downloads())
        .plugin(webview::plugin())
        .plugin(plugins::network())
        .plugin(plugins::updates());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(feature = "native-test")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .manage(Core::default())
        .setup(|app| {
            #[cfg(not(feature = "native-test"))]
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "native-test")]
            let data_dir = std::env::var_os("GRIPREAD_TEST_DATA_DIR")
                .map(std::path::PathBuf::from)
                .ok_or("native-test builds require an isolated GRIPREAD_TEST_DATA_DIR")?;
            let handle = app.handle().clone();
            // Opening may upgrade the database, which can take a while;
            // commands wait for it (see `Core`).
            std::thread::spawn(move || {
                let state = AppState::open(
                    data_dir,
                    Arc::new(plugins::TauriEvents(handle.clone())),
                    Arc::new(plugins::AppPlatform(handle.clone())),
                );
                if let Err(error) = &state {
                    eprintln!("Unable to open GripRead's data: {error}");
                }
                handle.state::<Core>().0.send_replace(Some(state));
            });
            app.manage(ExitPermission::default());
            #[cfg(target_os = "macos")]
            {
                // AppKit's predefined Quit invokes terminate: directly and
                // bypasses the runtime exit-request handshake. Keep the native
                // menu placement and accelerator, but route Quit via Tauri.
                let menu = tauri::menu::Menu::default(app.handle())?;
                let app_menu = menu
                    .items()?
                    .into_iter()
                    .next()
                    .and_then(|item| item.as_submenu().cloned())
                    .ok_or("native application menu is missing")?;
                let items = app_menu.items()?;
                let quit = items
                    .last()
                    .and_then(|item| item.as_predefined_menuitem())
                    .ok_or("native Quit menu item is missing")?;
                let replacement = tauri::menu::MenuItem::with_id(
                    app,
                    "gripread-quit",
                    quit.text()?,
                    true,
                    Some("CmdOrCtrl+Q"),
                )?;
                app_menu.remove(quit)?;
                app_menu.append(&replacement)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "gripread-quit" {
                        app.exit(0);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc, complete_exit, request_exit])
        .build(tauri::generate_context!())
        .expect("error while building GripRead")
        .run(|app, event| {
            // Android may cut connections while the app is away.
            #[cfg(mobile)]
            if let tauri::RunEvent::WindowEvent { event, .. } = &event {
                match event {
                    tauri::WindowEvent::Suspended => {
                        if let Some(state) = app.state::<Core>().get() {
                            state.sync.set_background(true);
                        }
                    }
                    tauri::WindowEvent::Resumed => {
                        if let Some(state) = app.state::<Core>().get() {
                            state.sync.set_background(false);
                        }
                    }
                    _ => {}
                }
            }
            if let tauri::RunEvent::Resumed = event {
                let Some(state) = app.state::<Core>().get() else {
                    return;
                };
                let root = state.data_root.clone();
                std::thread::spawn(move || gripread_core::network::refresh(&root));
                // Back in the foreground: catch up with the server (mobile
                // does so as its window resumes).
                #[cfg(not(mobile))]
                state.sync.now();
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app
                    .state::<ExitPermission>()
                    .0
                    .swap(false, Ordering::AcqRel)
                {
                    return;
                }
                if let Some(window) = app.get_webview_window("main") {
                    api.prevent_exit();
                    // The frontend acknowledges only after ordered position/settings saves finish.
                    if let Err(error) = window.emit("app-exit-requested", ()) {
                        eprintln!("Unable to request exit flush: {error}");
                    }
                }
            }
        });
}
