pub mod app_log;
mod cloud;
pub mod commands;
pub mod documents;
pub mod error;
pub mod m1_txt;
pub mod models;
mod online_commands;
mod online_reader;
mod progress_sync;
mod relocation;
pub mod source_commands;
pub mod sources;
pub mod storage;
mod transform;
pub mod txt;
pub mod txt_toc;
pub mod typegen;
mod webdav;

use commands::{acknowledge_book_progress, delete_book, fetch_book_progress, upload_book_progress};
use commands::{
    add_bookmark, cancel_import, cancel_search, cancel_txt_decode, create_group, delete_bookmark,
    delete_group, delete_txt_toc_rule, export_txt_toc_rules, get_book_info, get_import_status,
    get_saved_reader_locator, get_settings, get_shelf_preferences, get_txt_decode_status,
    get_txt_encoding, import_txt_toc_rules, list_bookmarks, list_books, list_groups,
    list_removed_books, list_toc, list_txt_toc_rules, order_txt_toc_rules, read_content_window,
    reassociate_txt_source, remove_book, rename_group, resolve_reader_locator,
    resolve_reader_offset, restore_book, save_book_toc_settings, save_reader_locator,
    save_settings, save_shelf_preferences, save_txt_toc_rule, search_book, set_txt_encoding,
    start_import, start_txt_decode, test_txt_toc_rule, update_book, AppState,
};
use commands::{
    add_reading_time, clear_book_cover, delete_reader_font, import_reader_background,
    import_reader_font, list_reader_fonts, list_txt_folder, move_book, read_reader_font,
    reading_stats, set_book_cover, update_bookmark_note,
};
use commands::{
    backup_to_webdav, clear_logs, delete_cloud_book, delete_remote_backup, download_cloud_book,
    export_backup_file, export_log_text, get_webdav_settings, list_cloud_books, list_log_entries,
    list_recovery_points, list_remote_backups, log_frontend, preview_backup, restore_backup,
    run_automatic_backup, save_webdav_settings, set_backup_folder, set_detailed_log, test_webdav,
    upload_cloud_books,
};
use commands::{
    delete_replace_rules, ensure_text_transforms, export_replace_rules, import_replace_rules,
    list_replace_rules, order_replace_rules, save_replace_rule, set_book_replace_rules,
    test_replace_rule,
};
use online_commands::{
    add_online_book, cache_online_chapters, change_online_source, clear_online_cache,
    explore_books, explore_kinds, find_online_book, get_library_book, leave_online_book,
    list_online_chapters, online_book_chapters, online_book_info, online_chapter_content,
    online_cover, search_online_books, set_online_can_update, set_online_on_shelf,
    update_online_toc, OnlinePages,
};
use source_commands::{
    cancel_source_operation, change_book_sources_group, check_book_sources, clear_source_cookies,
    debug_book_source, delete_book_sources, export_book_sources, fetch_source_text,
    get_book_source, get_source_login_form, get_source_variable, import_book_sources,
    list_book_sources, login_book_source, move_book_sources, preview_source_import,
    save_book_source, set_book_sources_switch, set_source_variable, SourceOperations,
};
use source_commands::{export_book_sources_file, read_source_file};
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
            app_log::init(&data_dir);
            app_log::info(
                "app",
                format!("启动 GripRead {}", env!("CARGO_PKG_VERSION")),
            );
            app.manage(AppState::new(data_dir)?);
            app.manage(ExitPermission::default());
            app.manage(SourceOperations::default());
            app.manage(std::sync::Arc::new(OnlinePages::default()));
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
            list_book_sources,
            get_book_source,
            preview_source_import,
            import_book_sources,
            save_book_source,
            delete_book_sources,
            set_book_sources_switch,
            change_book_sources_group,
            move_book_sources,
            export_book_sources,
            fetch_source_text,
            get_source_login_form,
            login_book_source,
            get_source_variable,
            set_source_variable,
            clear_source_cookies,
            debug_book_source,
            check_book_sources,
            cancel_source_operation,
            read_source_file,
            export_book_sources_file,
            search_online_books,
            explore_kinds,
            explore_books,
            online_book_info,
            online_book_chapters,
            online_chapter_content,
            online_cover,
            add_online_book,
            change_online_source,
            find_online_book,
            get_library_book,
            set_online_on_shelf,
            set_online_can_update,
            leave_online_book,
            list_online_chapters,
            clear_online_cache,
            update_online_toc,
            cache_online_chapters,
            start_import,
            get_import_status,
            cancel_import,
            list_books,
            list_groups,
            create_group,
            rename_group,
            delete_group,
            move_book,
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
            list_txt_toc_rules,
            save_txt_toc_rule,
            delete_txt_toc_rule,
            order_txt_toc_rules,
            import_txt_toc_rules,
            export_txt_toc_rules,
            test_txt_toc_rule,
            save_book_toc_settings,
            get_book_info,
            import_reader_font,
            list_reader_fonts,
            read_reader_font,
            delete_reader_font,
            update_bookmark_note,
            add_reading_time,
            reading_stats,
            set_book_cover,
            clear_book_cover,
            list_txt_folder,
            import_reader_background,
            ensure_text_transforms,
            list_replace_rules,
            save_replace_rule,
            delete_replace_rules,
            order_replace_rules,
            import_replace_rules,
            export_replace_rules,
            test_replace_rule,
            set_book_replace_rules,
            get_webdav_settings,
            save_webdav_settings,
            test_webdav,
            backup_to_webdav,
            run_automatic_backup,
            list_remote_backups,
            delete_remote_backup,
            list_recovery_points,
            preview_backup,
            restore_backup,
            export_backup_file,
            list_log_entries,
            set_detailed_log,
            clear_logs,
            export_log_text,
            log_frontend,
            list_cloud_books,
            upload_cloud_books,
            download_cloud_book,
            delete_cloud_book,
            set_backup_folder,
            delete_book,
            upload_book_progress,
            fetch_book_progress,
            acknowledge_book_progress
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
