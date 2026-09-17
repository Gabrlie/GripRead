pub mod commands;
pub mod error;
pub mod models;
pub mod storage;
pub mod txt;
pub mod typegen;

use commands::{
    cancel_import, get_import_status, get_saved_reader_locator, list_books, read_content_window,
    save_reader_locator, start_import, AppState,
};
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(data_dir)?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_import,
            get_import_status,
            cancel_import,
            list_books,
            read_content_window,
            save_reader_locator,
            get_saved_reader_locator
        ])
        .run(tauri::generate_context!())
        .expect("error while running GripRead");
}
