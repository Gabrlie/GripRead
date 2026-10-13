//! `gripread-server`: configured by the environment.
//!
//! - `GRIPREAD_DATA`: the data folder (default `/data`)
//! - `GRIPREAD_PORT`: the port to listen on (default `8080`)
//! - `GRIPREAD_WEB`: the built page (default `/app/web`, skipped when absent)
//! - `GRIPREAD_PASSWORD`: the password, set on first run only

use std::net::SocketAddr;
use std::path::PathBuf;

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

#[tokio::main]
async fn main() {
    let data = PathBuf::from(env("GRIPREAD_DATA").unwrap_or_else(|| "/data".into()));
    let web = PathBuf::from(env("GRIPREAD_WEB").unwrap_or_else(|| "/app/web".into()));
    let port: u16 = env("GRIPREAD_PORT")
        .and_then(|port| port.parse().ok())
        .unwrap_or(8080);
    let config = gripread_server::Config {
        data,
        web: web.join("index.html").is_file().then_some(web),
        password: env("GRIPREAD_PASSWORD"),
    };
    let app = match gripread_server::app(config) {
        Ok(app) => app,
        Err(message) => {
            eprintln!("GripRead server failed to start: {message}");
            std::process::exit(1);
        }
    };
    let address = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Unable to listen on {address}: {error}");
            std::process::exit(1);
        }
    };
    println!("GripRead server listening on {address}");
    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await
    {
        eprintln!("GripRead server stopped: {error}");
    }
}

/// Ctrl-C, or the SIGTERM a container stop sends.
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}
