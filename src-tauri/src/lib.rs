pub mod commands;
pub mod error;
pub mod m1_txt;
pub mod models;
pub mod storage;
pub mod txt;
pub mod typegen;

use commands::{
    add_bookmark, cancel_import, cancel_search, cancel_txt_decode, create_group, delete_bookmark,
    delete_group, get_import_status, get_saved_reader_locator, get_settings, get_txt_decode_status,
    get_txt_encoding, list_bookmarks, list_books, list_groups, list_toc, read_content_window,
    reassociate_txt_source, rename_group, resolve_reader_locator, save_reader_locator,
    save_settings, search_book, set_book_groups, set_txt_encoding, start_import, start_txt_decode,
    AppState,
};
use tauri::{Emitter, Manager};

#[tauri::command]
fn complete_exit(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
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
            get_settings,
            save_settings,
            list_toc,
            list_bookmarks,
            add_bookmark,
            delete_bookmark,
            search_book,
            cancel_search,
            complete_exit
        ])
        .build(tauri::generate_context!())
        .expect("error while building GripRead")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
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
