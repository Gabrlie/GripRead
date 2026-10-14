//! GripRead's application core: the library, reader, book sources, sync,
//! and the commands every shell (the Tauri app, the server) serves through
//! [`api::dispatch`]. Nothing here depends on a platform shell; platform
//! work reaches the core through [`platform::Platform`], [`api::Events`],
//! and the engine's host interfaces.

pub mod api;
pub mod app_log;
pub mod cloud;
pub mod commands;
pub mod documents;
pub mod downloads;
pub mod epub;
pub mod error;
pub mod m1_txt;
pub mod models;
pub mod network;
pub mod online_commands;
pub mod online_reader;
pub mod platform;
pub mod progress_sync;
pub mod relocation;
pub mod rss;
pub mod rss_commands;
pub mod source_commands;
pub mod sources;
pub mod storage;
pub mod sync;
pub mod sync_client;
pub mod transform;
pub mod txt;
pub mod txt_toc;
pub mod typegen;
pub mod update;
pub mod webdav;
