pub mod commands;
pub mod documents;
pub mod error;
pub mod m1_txt;
pub mod models;
mod relocation;
pub mod storage;
pub mod txt;
pub mod typegen;

use commands::{
    add_bookmark, cancel_import, cancel_search, cancel_txt_decode, create_group, delete_bookmark,
    delete_group, get_import_status, get_saved_reader_locator, get_settings, get_shelf_preferences,
    get_toc_rule, get_txt_decode_status, get_txt_encoding, list_bookmarks, list_books, list_groups,
    list_removed_books, list_toc, preview_toc_rule, read_content_window, reassociate_txt_source,
    remove_book, rename_group, resolve_reader_locator, resolve_reader_offset, restore_book,
    save_reader_locator, save_settings, save_shelf_preferences, save_toc_rule, search_book,
    set_book_groups, set_txt_encoding, start_import, start_txt_decode, update_book, AppState,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

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
        .plugin(documents::init());
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
            app.manage(AppState::new(data_dir)?);
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
        .invoke_handler(tauri::generate_handler![
            start_import,
            get_import_status,
            cancel_import,
            list_books,
            list_groups,
            create_group,
            rename_group,
            delete_group,
            set_book_groups,
            get_txt_encoding,
            reassociate_txt_source,
            start_txt_decode,
            get_txt_decode_status,
            cancel_txt_decode,
            set_txt_encoding,
            read_content_window,
            save_reader_locator,
            get_saved_reader_locator,
            resolve_reader_locator,
            resolve_reader_offset,
            get_settings,
            save_settings,
            list_toc,
            list_bookmarks,
            add_bookmark,
            delete_bookmark,
            search_book,
            cancel_search,
            complete_exit,
            request_exit,
            update_book,
            remove_book,
            restore_book,
            list_removed_books,
            get_shelf_preferences,
            save_shelf_preferences,
            get_toc_rule,
            save_toc_rule,
            preview_toc_rule
        ])
        .build(tauri::generate_context!())
        .expect("error while building GripRead")
        .run(|app, event| {
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
