//! The update mirror for connected devices (`gripread_core::update`): the
//! release list from GitHub, cached for ten minutes, and release files,
//! downloaded once and kept for the two newest versions, so devices that
//! reach GitHub slowly download updates from their own server.

use super::*;
use gripread_core::update;

pub fn routes() -> Router<Arc<Server>> {
    Router::new()
        .route("/api/update/releases", get(releases))
        .route("/api/update/asset/{tag}/{name}", get(asset))
}

async fn releases(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if server.signed_in(&headers, None).is_none() {
        return unauthorized();
    }
    let root = server.core.data_root.clone();
    match tokio::task::spawn_blocking(move || update::cached_releases(&root)).await {
        Ok(Ok(releases)) => Json(releases).into_response(),
        Ok(Err(error)) => failure(StatusCode::BAD_GATEWAY, "upstream", &error.message),
        Err(error) => failure(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            &error.to_string(),
        ),
    }
}

async fn asset(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Path((tag, name)): Path<(String, String)>,
) -> Response {
    let Some(session) = server.signed_in(&headers, None) else {
        return unauthorized();
    };
    log(format!("「{}」经服务器下载更新 {name}", session.device));
    let root = server.core.data_root.clone();
    let path =
        match tokio::task::spawn_blocking(move || update::cached_asset(&root, &tag, &name)).await {
            Ok(Ok(path)) => path,
            Ok(Err(error)) if error.code == ErrorCode::FileNotFound => {
                return failure(StatusCode::NOT_FOUND, "not_found", &error.message)
            }
            Ok(Err(error)) => return failure(StatusCode::BAD_GATEWAY, "upstream", &error.message),
            Err(error) => {
                return failure(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    &error.to_string(),
                )
            }
        };
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return failure(StatusCode::NOT_FOUND, "not_found", "服务器上没有这个文件"),
    };
    let length = file
        .metadata()
        .await
        .map(|meta| meta.len())
        .unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, length.to_string()),
        ],
        Body::from_stream(tokio_util::io::ReaderStream::new(file)),
    )
        .into_response()
}
