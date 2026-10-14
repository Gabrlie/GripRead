//! The commands the core serves, by name, for every shell: the Tauri app's
//! `rpc` command and the server's `/api/rpc/{name}` both call [`dispatch`]
//! with the arguments the page sent (`{ request }` or nothing).

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::commands::AppState;
use crate::error::{AppError, ErrorCode};

/// Where the core reports progress and changes (`import-progress`,
/// `download-progress`, …): Tauri events in the app, a WebSocket on the server.
pub trait Events: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Events nobody listens to (tools and tests).
pub struct NoEvents;

impl Events for NoEvents {
    fn emit(&self, _event: &str, _payload: Value) {}
}

fn request<T: DeserializeOwned>(args: Value) -> Result<T, AppError> {
    let value = match args {
        Value::Object(mut map) => map.remove("request").unwrap_or(Value::Null),
        _ => Value::Null,
    };
    serde_json::from_value(value)
        .map_err(|error| AppError::invalid_argument(format!("invalid request: {error}")))
}

/// A command's answer: JSON, or raw bytes (fonts, covers) sent as they are.
#[derive(Debug)]
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

fn reply<T: Serialize>(result: Result<T, AppError>) -> Result<Reply, AppError> {
    serde_json::to_value(result?)
        .map(Reply::Json)
        .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))
}

fn bytes(result: Result<Vec<u8>, AppError>) -> Result<Reply, AppError> {
    result.map(Reply::Bytes)
}

/// Whether a command can change what sync carries. Reads, searches, source
/// fetches, checks, exports, and the log cannot; anything else may.
pub fn mutates(name: &str) -> bool {
    const READS: &[&str] = &[
        "get_",
        "list_",
        "read_",
        "search_",
        "preview_",
        "explore_",
        "fetch_",
        "test_",
        "check_",
        "export_",
        "resolve_",
        "cancel_",
        "debug_",
        "find_",
        "online_book_",
        "online_chapter_",
        "online_cover",
        "data_usage",
        "reading_stats",
        "network_state",
        "download_list",
        "log_frontend",
        "clear_logs",
        "set_detailed_log",
        // Update settings and installs stay on the device.
        "save_update_settings",
        "install_update",
        "forget_sync_server_login",
        "server_api",
        "discover_",
        "rss_image",
    ];
    !READS.iter().any(|read| name.starts_with(read))
}

/// The command names [`dispatch`] answers.
pub const COMMANDS: &[&str] = &[
    "list_feeds",
    "discover_feed",
    "add_feed",
    "update_feed",
    "remove_feeds",
    "refresh_feeds",
    "list_articles",
    "get_article",
    "fetch_full_text",
    "set_article_state",
    "mark_all_read",
    "rss_image",
    "import_opml",
    "export_opml_file",
    "get_rss_settings",
    "save_rss_settings",
    "list_book_images",
    "read_book_image",
    "check_update",
    "get_update_settings",
    "install_update",
    "save_update_settings",
    "connect_sync_server",
    "disconnect_sync_server",
    "forget_sync_server_login",
    "server_api",
    "get_sync_server",
    "set_sync_auto_download",
    "set_sync_open_book",
    "sync_now",
    "acknowledge_book_progress",
    "add_bookmark",
    "add_online_book",
    "add_reading_time",
    "backup_to_webdav",
    "cancel_import",
    "cancel_search",
    "cancel_source_operation",
    "cancel_txt_decode",
    "change_book_sources_group",
    "change_online_source",
    "check_book_sources",
    "check_network",
    "clear_book_cover",
    "clear_data",
    "clear_logs",
    "clear_online_cache",
    "clear_source_cookies",
    "convert_online_to_local",
    "create_group",
    "data_usage",
    "debug_book_source",
    "delete_book",
    "delete_book_sources",
    "delete_bookmark",
    "delete_cloud_book",
    "delete_group",
    "delete_reader_font",
    "delete_reading_record",
    "delete_remote_backup",
    "delete_replace_rules",
    "delete_txt_toc_rule",
    "download_cancel",
    "download_clear_finished",
    "download_cloud_book",
    "download_enqueue",
    "download_list",
    "download_pause",
    "download_pause_all",
    "download_resume",
    "ensure_text_transforms",
    "explore_books",
    "explore_kinds",
    "export_backup_file",
    "export_book_sources",
    "export_book_sources_file",
    "export_log_text",
    "export_replace_rules",
    "export_txt_toc_rules",
    "fetch_book_progress",
    "fetch_source_text",
    "find_online_book",
    "get_book_info",
    "get_book_source",
    "get_import_status",
    "get_library_book",
    "get_network_settings",
    "get_saved_reader_locator",
    "get_settings",
    "get_shelf_preferences",
    "get_source_login_form",
    "get_source_variable",
    "get_txt_decode_status",
    "get_txt_encoding",
    "get_webdav_settings",
    "import_book_sources",
    "import_reader_background",
    "import_reader_font",
    "import_replace_rules",
    "import_txt_toc_rules",
    "leave_online_book",
    "list_book_sources",
    "list_bookmarks",
    "list_books",
    "list_cloud_books",
    "list_groups",
    "list_log_entries",
    "list_online_chapters",
    "list_reader_fonts",
    "list_recovery_points",
    "list_remote_backups",
    "list_removed_books",
    "list_replace_rules",
    "list_toc",
    "list_txt_folder",
    "list_txt_toc_rules",
    "log_frontend",
    "login_book_source",
    "move_book",
    "move_book_sources",
    "network_state",
    "online_book_chapters",
    "online_book_info",
    "online_chapter_content",
    "online_cover",
    "order_replace_rules",
    "order_txt_toc_rules",
    "preview_backup",
    "preview_source_import",
    "read_content_window",
    "read_reader_font",
    "read_source_file",
    "reading_stats",
    "reassociate_txt_source",
    "remove_book",
    "rename_group",
    "resolve_reader_locator",
    "resolve_reader_offset",
    "restore_backup",
    "restore_book",
    "run_automatic_backup",
    "save_book_source",
    "save_book_toc_settings",
    "save_network_settings",
    "save_reader_locator",
    "save_replace_rule",
    "save_settings",
    "save_shelf_preferences",
    "save_txt_toc_rule",
    "save_webdav_settings",
    "search_book",
    "search_online_books",
    "set_backup_folder",
    "set_book_cover",
    "set_book_replace_rules",
    "set_book_sources_switch",
    "set_cover_from_source",
    "set_detailed_log",
    "set_online_can_update",
    "set_online_on_shelf",
    "set_source_variable",
    "set_txt_encoding",
    "start_import",
    "start_txt_decode",
    "test_replace_rule",
    "test_txt_toc_rule",
    "test_webdav",
    "update_book",
    "update_bookmark_note",
    "update_online_toc",
    "upload_book_progress",
    "upload_cloud_books",
];

/// Runs the command `name` with the page's arguments; one that may change
/// what sync carries starts a sync once changes pause.
pub async fn dispatch(state: &Arc<AppState>, name: &str, args: Value) -> Result<Reply, AppError> {
    let reply = run(state, name, args).await;
    if reply.is_ok() && mutates(name) {
        state.sync.changed();
    }
    reply
}

async fn run(state: &Arc<AppState>, name: &str, args: Value) -> Result<Reply, AppError> {
    match name {
        "acknowledge_book_progress" => {
            reply(crate::commands::acknowledge_book_progress(state, request(args)?).await)
        }
        "add_bookmark" => reply(crate::commands::add_bookmark(state, request(args)?).await),
        "add_online_book" => {
            reply(crate::online_commands::add_online_book(state, request(args)?).await)
        }
        "add_reading_time" => reply(crate::commands::add_reading_time(state, request(args)?).await),
        "backup_to_webdav" => reply(crate::commands::backup_to_webdav(state).await),
        "list_book_images" => reply(crate::commands::list_book_images(state, request(args)?).await),
        "read_book_image" => bytes(crate::commands::read_book_image(state, request(args)?).await),
        "check_update" => reply(crate::update::check_update(state, request(args)?).await),
        "get_update_settings" => reply(crate::update::get_update_settings(state).await),
        "install_update" => reply(crate::update::install_update(state, request(args)?).await),
        "save_update_settings" => {
            reply(crate::update::save_update_settings(state, request(args)?).await)
        }
        "cancel_import" => reply(crate::commands::cancel_import(state, request(args)?).await),
        "cancel_search" => reply(crate::commands::cancel_search(state, request(args)?).await),
        "cancel_source_operation" => {
            reply(crate::source_commands::cancel_source_operation(state, request(args)?).await)
        }
        "cancel_txt_decode" => {
            reply(crate::commands::cancel_txt_decode(state, request(args)?).await)
        }
        "change_book_sources_group" => {
            reply(crate::source_commands::change_book_sources_group(state, request(args)?).await)
        }
        "change_online_source" => {
            reply(crate::online_commands::change_online_source(state, request(args)?).await)
        }
        "check_book_sources" => {
            reply(crate::source_commands::check_book_sources(state, request(args)?).await)
        }
        "check_network" => {
            reply(crate::online_commands::check_network(state, request(args)?).await)
        }
        "clear_book_cover" => reply(crate::commands::clear_book_cover(state, request(args)?).await),
        "clear_data" => reply(crate::online_commands::clear_data(state, request(args)?).await),
        "clear_logs" => {
            crate::commands::clear_logs(state);
            reply(Ok(()))
        }
        "clear_online_cache" => {
            reply(crate::online_commands::clear_online_cache(state, request(args)?).await)
        }
        "clear_source_cookies" => {
            reply(crate::source_commands::clear_source_cookies(state, request(args)?).await)
        }
        "convert_online_to_local" => {
            reply(crate::online_commands::convert_online_to_local(state, request(args)?).await)
        }
        "create_group" => reply(crate::commands::create_group(state, request(args)?).await),
        "data_usage" => reply(crate::online_commands::data_usage(state).await),
        "debug_book_source" => {
            reply(crate::source_commands::debug_book_source(state, request(args)?).await)
        }
        "delete_book" => reply(crate::commands::delete_book(state, request(args)?).await),
        "delete_book_sources" => {
            reply(crate::source_commands::delete_book_sources(state, request(args)?).await)
        }
        "delete_bookmark" => reply(crate::commands::delete_bookmark(state, request(args)?).await),
        "delete_cloud_book" => {
            reply(crate::commands::delete_cloud_book(state, request(args)?).await)
        }
        "delete_group" => reply(crate::commands::delete_group(state, request(args)?).await),
        "delete_reader_font" => {
            reply(crate::commands::delete_reader_font(state, request(args)?).await)
        }
        "delete_reading_record" => {
            reply(crate::commands::delete_reading_record(state, request(args)?).await)
        }
        "delete_remote_backup" => {
            reply(crate::commands::delete_remote_backup(state, request(args)?).await)
        }
        "delete_replace_rules" => {
            reply(crate::commands::delete_replace_rules(state, request(args)?).await)
        }
        "delete_txt_toc_rule" => {
            reply(crate::commands::delete_txt_toc_rule(state, request(args)?).await)
        }
        "download_cancel" => {
            crate::online_commands::download_cancel(state, request(args)?);
            reply(Ok(()))
        }
        "download_clear_finished" => {
            crate::online_commands::download_clear_finished(state);
            reply(Ok(()))
        }
        "download_cloud_book" => {
            reply(crate::commands::download_cloud_book(state, request(args)?).await)
        }
        "download_enqueue" => {
            reply(crate::online_commands::download_enqueue(state, request(args)?).await)
        }
        "download_list" => reply(Ok::<_, AppError>(crate::online_commands::download_list(
            state,
        ))),
        "download_pause" => {
            crate::online_commands::download_pause(state, request(args)?);
            reply(Ok(()))
        }
        "download_pause_all" => {
            crate::online_commands::download_pause_all(state);
            reply(Ok(()))
        }
        "download_resume" => {
            crate::online_commands::download_resume(state, request(args)?);
            reply(Ok(()))
        }
        "ensure_text_transforms" => {
            reply(crate::commands::ensure_text_transforms(state, request(args)?).await)
        }
        "explore_books" => {
            reply(crate::online_commands::explore_books(state, request(args)?).await)
        }
        "explore_kinds" => {
            reply(crate::online_commands::explore_kinds(state, request(args)?).await)
        }
        "export_backup_file" => {
            reply(crate::commands::export_backup_file(state, request(args)?).await)
        }
        "export_book_sources" => {
            reply(crate::source_commands::export_book_sources(state, request(args)?).await)
        }
        "export_book_sources_file" => {
            reply(crate::source_commands::export_book_sources_file(state, request(args)?).await)
        }
        "export_log_text" => reply(Ok::<_, AppError>(crate::commands::export_log_text(state))),
        "export_replace_rules" => reply(crate::commands::export_replace_rules(state).await),
        "export_txt_toc_rules" => reply(crate::commands::export_txt_toc_rules(state).await),
        "fetch_book_progress" => {
            reply(crate::commands::fetch_book_progress(state, request(args)?).await)
        }
        "fetch_source_text" => {
            reply(crate::source_commands::fetch_source_text(state, request(args)?).await)
        }
        "find_online_book" => {
            reply(crate::online_commands::find_online_book(state, request(args)?).await)
        }
        "get_book_info" => reply(crate::commands::get_book_info(state, request(args)?).await),
        "get_book_source" => {
            reply(crate::source_commands::get_book_source(state, request(args)?).await)
        }
        "get_import_status" => {
            reply(crate::commands::get_import_status(state, request(args)?).await)
        }
        "get_library_book" => {
            reply(crate::online_commands::get_library_book(state, request(args)?).await)
        }
        "get_network_settings" => reply(Ok::<_, AppError>(
            crate::online_commands::get_network_settings(state),
        )),
        "get_saved_reader_locator" => {
            reply(crate::commands::get_saved_reader_locator(state, request(args)?).await)
        }
        "get_settings" => reply(crate::commands::get_settings(state).await),
        "get_shelf_preferences" => reply(crate::commands::get_shelf_preferences(state).await),
        "get_source_login_form" => {
            reply(crate::source_commands::get_source_login_form(state, request(args)?).await)
        }
        "get_source_variable" => {
            reply(crate::source_commands::get_source_variable(state, request(args)?).await)
        }
        "get_txt_decode_status" => {
            reply(crate::commands::get_txt_decode_status(state, request(args)?).await)
        }
        "get_txt_encoding" => reply(crate::commands::get_txt_encoding(state, request(args)?).await),
        "get_webdav_settings" => reply(crate::commands::get_webdav_settings(state).await),
        "import_book_sources" => {
            reply(crate::source_commands::import_book_sources(state, request(args)?).await)
        }
        "import_reader_background" => {
            reply(crate::commands::import_reader_background(state, request(args)?).await)
        }
        "import_reader_font" => {
            reply(crate::commands::import_reader_font(state, request(args)?).await)
        }
        "import_replace_rules" => {
            reply(crate::commands::import_replace_rules(state, request(args)?).await)
        }
        "import_txt_toc_rules" => {
            reply(crate::commands::import_txt_toc_rules(state, request(args)?).await)
        }
        "leave_online_book" => {
            reply(crate::online_commands::leave_online_book(state, request(args)?).await)
        }
        "list_book_sources" => reply(crate::source_commands::list_book_sources(state).await),
        "list_bookmarks" => reply(crate::commands::list_bookmarks(state, request(args)?).await),
        "list_books" => reply(crate::commands::list_books(state).await),
        "list_cloud_books" => reply(crate::commands::list_cloud_books(state).await),
        "list_groups" => reply(crate::commands::list_groups(state).await),
        "list_log_entries" => reply(Ok::<_, AppError>(crate::commands::list_log_entries(
            state,
            request(args)?,
        ))),
        "list_online_chapters" => {
            reply(crate::online_commands::list_online_chapters(state, request(args)?).await)
        }
        "list_reader_fonts" => reply(crate::commands::list_reader_fonts(state).await),
        "list_recovery_points" => reply(crate::commands::list_recovery_points(state).await),
        "list_remote_backups" => reply(crate::commands::list_remote_backups(state).await),
        "list_removed_books" => reply(crate::commands::list_removed_books(state).await),
        "list_replace_rules" => reply(crate::commands::list_replace_rules(state).await),
        "list_toc" => reply(crate::commands::list_toc(state, request(args)?).await),
        "list_txt_folder" => reply(crate::commands::list_txt_folder(state, request(args)?).await),
        "list_txt_toc_rules" => reply(crate::commands::list_txt_toc_rules(state).await),
        "log_frontend" => {
            crate::commands::log_frontend(state, request(args)?);
            reply(Ok(()))
        }
        "login_book_source" => {
            reply(crate::source_commands::login_book_source(state, request(args)?).await)
        }
        "move_book" => reply(crate::commands::move_book(state, request(args)?).await),
        "move_book_sources" => {
            reply(crate::source_commands::move_book_sources(state, request(args)?).await)
        }
        "network_state" => reply(crate::online_commands::network_state(state).await),
        "online_book_chapters" => {
            reply(crate::online_commands::online_book_chapters(state, request(args)?).await)
        }
        "online_book_info" => {
            reply(crate::online_commands::online_book_info(state, request(args)?).await)
        }
        "online_chapter_content" => {
            reply(crate::online_commands::online_chapter_content(state, request(args)?).await)
        }
        "online_cover" => bytes(crate::online_commands::online_cover(state, request(args)?).await),
        "order_replace_rules" => {
            reply(crate::commands::order_replace_rules(state, request(args)?).await)
        }
        "order_txt_toc_rules" => {
            reply(crate::commands::order_txt_toc_rules(state, request(args)?).await)
        }
        "preview_backup" => reply(crate::commands::preview_backup(state, request(args)?).await),
        "preview_source_import" => {
            reply(crate::source_commands::preview_source_import(state, request(args)?).await)
        }
        "read_content_window" => {
            reply(crate::commands::read_content_window(state, request(args)?).await)
        }
        "read_reader_font" => bytes(crate::commands::read_reader_font(state, request(args)?).await),
        "read_source_file" => {
            reply(crate::source_commands::read_source_file(state, request(args)?).await)
        }
        "reading_stats" => reply(crate::commands::reading_stats(state, request(args)?).await),
        "reassociate_txt_source" => {
            reply(crate::commands::reassociate_txt_source(state, request(args)?).await)
        }
        "remove_book" => reply(crate::commands::remove_book(state, request(args)?).await),
        "rename_group" => reply(crate::commands::rename_group(state, request(args)?).await),
        "resolve_reader_locator" => {
            reply(crate::commands::resolve_reader_locator(state, request(args)?).await)
        }
        "resolve_reader_offset" => {
            reply(crate::commands::resolve_reader_offset(state, request(args)?).await)
        }
        "restore_backup" => reply(crate::commands::restore_backup(state, request(args)?).await),
        "restore_book" => reply(crate::commands::restore_book(state, request(args)?).await),
        "run_automatic_backup" => reply(crate::commands::run_automatic_backup(state).await),
        "save_book_source" => {
            reply(crate::source_commands::save_book_source(state, request(args)?).await)
        }
        "save_book_toc_settings" => {
            reply(crate::commands::save_book_toc_settings(state, request(args)?).await)
        }
        "save_network_settings" => {
            reply(crate::online_commands::save_network_settings(state, request(args)?).await)
        }
        "save_reader_locator" => {
            reply(crate::commands::save_reader_locator(state, request(args)?).await)
        }
        "save_replace_rule" => {
            reply(crate::commands::save_replace_rule(state, request(args)?).await)
        }
        "save_settings" => reply(crate::commands::save_settings(state, request(args)?).await),
        "save_shelf_preferences" => {
            reply(crate::commands::save_shelf_preferences(state, request(args)?).await)
        }
        "save_txt_toc_rule" => {
            reply(crate::commands::save_txt_toc_rule(state, request(args)?).await)
        }
        "save_webdav_settings" => {
            reply(crate::commands::save_webdav_settings(state, request(args)?).await)
        }
        "search_book" => reply(crate::commands::search_book(state, request(args)?).await),
        "search_online_books" => {
            reply(crate::online_commands::search_online_books(state, request(args)?).await)
        }
        "set_backup_folder" => {
            reply(crate::commands::set_backup_folder(state, request(args)?).await)
        }
        "set_book_cover" => reply(crate::commands::set_book_cover(state, request(args)?).await),
        "set_book_replace_rules" => {
            reply(crate::commands::set_book_replace_rules(state, request(args)?).await)
        }
        "set_book_sources_switch" => {
            reply(crate::source_commands::set_book_sources_switch(state, request(args)?).await)
        }
        "set_cover_from_source" => {
            reply(crate::online_commands::set_cover_from_source(state, request(args)?).await)
        }
        "set_detailed_log" => reply(Ok::<_, AppError>(crate::commands::set_detailed_log(
            state,
            request(args)?,
        ))),
        "set_online_can_update" => {
            reply(crate::online_commands::set_online_can_update(state, request(args)?).await)
        }
        "set_online_on_shelf" => {
            reply(crate::online_commands::set_online_on_shelf(state, request(args)?).await)
        }
        "set_source_variable" => {
            reply(crate::source_commands::set_source_variable(state, request(args)?).await)
        }
        "set_txt_encoding" => reply(crate::commands::set_txt_encoding(state, request(args)?).await),
        "start_import" => reply(crate::commands::start_import(state, request(args)?).await),
        "start_txt_decode" => reply(crate::commands::start_txt_decode(state, request(args)?).await),
        "test_replace_rule" => {
            reply(crate::commands::test_replace_rule(state, request(args)?).await)
        }
        "test_txt_toc_rule" => {
            reply(crate::commands::test_txt_toc_rule(state, request(args)?).await)
        }
        "test_webdav" => reply(crate::commands::test_webdav(state, request(args)?).await),
        "update_book" => reply(crate::commands::update_book(state, request(args)?).await),
        "update_bookmark_note" => {
            reply(crate::commands::update_bookmark_note(state, request(args)?).await)
        }
        "update_online_toc" => {
            reply(crate::online_commands::update_online_toc(state, request(args)?).await)
        }
        "upload_book_progress" => {
            reply(crate::commands::upload_book_progress(state, request(args)?).await)
        }
        "upload_cloud_books" => {
            reply(crate::commands::upload_cloud_books(state, request(args)?).await)
        }
        "get_sync_server" => reply(crate::commands::get_sync_server(state).await),
        "connect_sync_server" => {
            reply(crate::commands::connect_sync_server(state, request(args)?).await)
        }
        "disconnect_sync_server" => reply(crate::commands::disconnect_sync_server(state).await),
        "list_feeds" => reply(crate::rss_commands::list_feeds(state).await),
        "discover_feed" => reply(crate::rss_commands::discover_feed(state, request(args)?).await),
        "add_feed" => reply(crate::rss_commands::add_feed(state, request(args)?).await),
        "update_feed" => reply(crate::rss_commands::update_feed(state, request(args)?).await),
        "remove_feeds" => reply(crate::rss_commands::remove_feeds(state, request(args)?).await),
        "refresh_feeds" => reply(crate::rss_commands::refresh_feeds(state, request(args)?).await),
        "list_articles" => reply(crate::rss_commands::list_articles(state, request(args)?).await),
        "get_article" => reply(crate::rss_commands::get_article(state, request(args)?).await),
        "fetch_full_text" => {
            reply(crate::rss_commands::fetch_full_text(state, request(args)?).await)
        }
        "set_article_state" => {
            reply(crate::rss_commands::set_article_state(state, request(args)?).await)
        }
        "mark_all_read" => reply(crate::rss_commands::mark_all_read(state, request(args)?).await),
        "rss_image" => bytes(crate::rss_commands::rss_image(state, request(args)?).await),
        "import_opml" => reply(crate::rss_commands::import_opml(state, request(args)?).await),
        "export_opml_file" => {
            reply(crate::rss_commands::export_opml_file(state, request(args)?).await)
        }
        "get_rss_settings" => reply(crate::rss_commands::get_rss_settings(state).await),
        "save_rss_settings" => {
            reply(crate::rss_commands::save_rss_settings(state, request(args)?).await)
        }
        "server_api" => {
            let request: crate::models::ServerApiRequest = request(args)?;
            let sync = state.sync.clone();
            reply(
                tokio::task::spawn_blocking(move || {
                    sync.api(&request.method, &request.path, request.body)
                })
                .await
                .map_err(|error| AppError::new(ErrorCode::Io, error.to_string()))
                .and_then(|reply| reply),
            )
        }
        "forget_sync_server_login" => {
            state.sync.forget_login();
            reply(Ok(state.sync.status()))
        }
        "sync_now" => {
            crate::commands::sync_now(state);
            reply(Ok(()))
        }
        "set_sync_auto_download" => reply(Ok::<_, AppError>(
            crate::commands::set_sync_auto_download(state, request(args)?),
        )),
        "set_sync_open_book" => {
            crate::commands::set_sync_open_book(state, request(args)?);
            reply(Ok(()))
        }
        _ => Err(AppError::new(
            ErrorCode::InvalidArgument,
            format!("unknown command: {name}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::Filesystem;

    #[test]
    fn reads_do_not_count_as_changes() {
        for name in [
            "list_books",
            "read_content_window",
            "search_online_books",
            "get_settings",
        ] {
            assert!(!mutates(name), "{name}");
        }
        for name in [
            "save_reader_locator",
            "update_book",
            "add_bookmark",
            "save_settings",
        ] {
            assert!(mutates(name), "{name}");
        }
    }

    /// Every command the page calls is one the core answers.
    #[test]
    fn the_page_calls_only_core_commands() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/services");
        let pattern =
            regex::Regex::new(r#"(?:invokeCommand|call)<[^>]*>\(\s*"([a-z_]+)""#).unwrap();
        let mut called = Vec::new();
        for file in ["ipc.ts", "log.ts"] {
            let text = std::fs::read_to_string(root.join(file)).unwrap();
            called.extend(
                pattern
                    .captures_iter(&text)
                    .map(|found| found[1].to_string()),
            );
        }
        assert!(called.len() > 100, "found {} calls", called.len());
        let missing: Vec<&String> = called
            .iter()
            .filter(|name| !COMMANDS.contains(&name.as_str()))
            .collect();
        assert!(missing.is_empty(), "unknown commands: {missing:?}");
    }

    #[tokio::test]
    async fn commands_run_by_name_with_their_request() {
        let root = std::env::temp_dir().join(format!("gripread-api-{}", uuid::Uuid::new_v4()));
        let state = AppState::open(root.clone(), Arc::new(NoEvents), Arc::new(Filesystem)).unwrap();
        let created = dispatch(
            &state,
            "create_group",
            serde_json::json!({ "request": { "name": "收藏" } }),
        )
        .await
        .unwrap();
        let Reply::Json(created) = created else {
            panic!("a group is JSON");
        };
        assert_eq!(created["name"], "收藏");
        let Reply::Json(groups) = dispatch(&state, "list_groups", Value::Null).await.unwrap()
        else {
            panic!("groups are JSON");
        };
        assert_eq!(groups.as_array().map(Vec::len), Some(1));
        let missing = dispatch(&state, "create_group", Value::Null)
            .await
            .unwrap_err();
        assert_eq!(missing.code, ErrorCode::InvalidArgument);
        let unknown = dispatch(&state, "no_such_command", Value::Null)
            .await
            .unwrap_err();
        assert!(unknown.message.contains("no_such_command"));
        drop(state);
        let _ = std::fs::remove_dir_all(root);
    }
}
