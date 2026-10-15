//! The Tauri app: the core's commands behind one `rpc` command, its events
//! as Tauri events, and the platform plugins (documents, downloads, network,
//! and the WebView for sources).

mod plugins;
mod webview;

use gripread_core::api::{self, Reply};
use gripread_core::commands::AppState;
use gripread_core::error::AppError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::{InvokeResponseBody, Response};
use tauri::{Emitter, Manager};

/// Runs a core command by name (see `gripread_core::api`).
#[tauri::command]
async fn rpc(
    name: String,
    args: Option<serde_json::Value>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Response, AppError> {
    let state = state.inner().clone();
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
        .setup(|app| {
            #[cfg(not(feature = "native-test"))]
            let data_dir = app.path().app_data_dir()?;
            #[cfg(feature = "native-test")]
            let data_dir = std::env::var_os("GRIPREAD_TEST_DATA_DIR")
                .map(std::path::PathBuf::from)
                .ok_or("native-test builds require an isolated GRIPREAD_TEST_DATA_DIR")?;
            let handle = app.handle().clone();
            let state = AppState::open(
                data_dir,
                Arc::new(plugins::TauriEvents(handle.clone())),
                Arc::new(plugins::AppPlatform(handle)),
            )?;
            app.manage(state);
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
                        app.state::<Arc<AppState>>().sync.set_background(true);
                    }
                    tauri::WindowEvent::Resumed => {
                        app.state::<Arc<AppState>>().sync.set_background(false);
                    }
                    _ => {}
                }
            }
            if let tauri::RunEvent::Resumed = event {
                let state = app.state::<Arc<AppState>>();
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
