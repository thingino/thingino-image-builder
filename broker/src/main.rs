//! Thingino web-builder broker.
//!
//! A thin control plane — it NEVER builds. It:
//!   * serves the static frontend (same-origin, no CORS),
//!   * validates the requested defconfig against an allowlist,
//!   * enforces global + per-IP hourly build caps (SQLite, exact, persistent),
//!   * fires a `repository_dispatch` (event `web-build`) at the builder repo,
//!   * proxies a cheap readiness check for the resulting release asset.
//!
//! Config via env: GITHUB_TOKEN, GITHUB_REPO (required); BIND_ADDR, STATIC_DIR,
//! DB_PATH, DEFCONFIGS_PATH, ROLLING_TAG, GLOBAL_HOURLY_LIMIT,
//! PER_IP_HOURLY_LIMIT, IP_HEADER (optional).

use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::json;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    db: Arc<Mutex<Connection>>,
    http: reqwest::Client,
    github_token: String,
    github_repo: String,
    rolling_tag: String,
    defconfigs: Arc<HashSet<String>>,
    defconfigs_list: Arc<Vec<String>>,
    global_limit: i64,
    per_ip_limit: i64,
    ip_header: Option<String>,
}

const WINDOW_SECS: i64 = 3600;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// A build_id is a UUID — hex digits and dashes only. Cheap shape check so we
/// never interpolate junk into a URL or the DB.
fn valid_build_id(s: &str) -> bool {
    let len = s.len();
    (8..=40).contains(&len) && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let github_token = std::env::var("GITHUB_TOKEN")
        .map_err(|_| anyhow::anyhow!("GITHUB_TOKEN is required"))?;
    let github_repo = std::env::var("GITHUB_REPO")
        .map_err(|_| anyhow::anyhow!("GITHUB_REPO is required (owner/repo)"))?;
    let bind_addr = env_or("BIND_ADDR", "127.0.0.1:8080");
    let static_dir = env_or("STATIC_DIR", "web");
    let db_path = env_or("DB_PATH", "broker.db");
    let defconfigs_path = env_or("DEFCONFIGS_PATH", "defconfigs.json");
    let rolling_tag = env_or("ROLLING_TAG", "web-builds");
    let global_limit: i64 = env_or("GLOBAL_HOURLY_LIMIT", "10").parse().unwrap_or(10);
    let per_ip_limit: i64 = env_or("PER_IP_HOURLY_LIMIT", "2").parse().unwrap_or(2);
    let ip_header = std::env::var("IP_HEADER").ok().filter(|s| !s.is_empty());

    // Allowlist of buildable defconfigs (single source of truth for both the
    // dropdown and request validation).
    let raw = std::fs::read_to_string(&defconfigs_path)
        .map_err(|e| anyhow::anyhow!("reading {defconfigs_path}: {e}"))?;
    let list: Vec<String> = serde_json::from_str(&raw)?;
    let defconfigs: HashSet<String> = list.iter().cloned().collect();
    tracing::info!("loaded {} defconfigs from {}", list.len(), defconfigs_path);

    let conn = Connection::open(&db_path)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS builds(
            id        TEXT PRIMARY KEY,
            ip        TEXT NOT NULL,
            defconfig TEXT NOT NULL,
            ts        INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_builds_ts    ON builds(ts);
         CREATE INDEX IF NOT EXISTS idx_builds_ip_ts ON builds(ip, ts);",
    )?;

    let http = reqwest::Client::builder()
        .user_agent("thingino-web-builder-broker")
        .build()?;

    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        http,
        github_token,
        github_repo,
        rolling_tag,
        defconfigs: Arc::new(defconfigs),
        defconfigs_list: Arc::new(list),
        global_limit,
        per_ip_limit,
        ip_header,
    };

    let app = Router::new()
        .route("/api/health", get(|| async { "ok" }))
        .route("/api/defconfigs", get(get_defconfigs))
        .route("/api/build", post(post_build))
        .route("/api/status/{build_id}", get(get_status))
        .fallback_service(ServeDir::new(&static_dir).append_index_html_on_directories(true))
        .with_state(state);

    let addr: SocketAddr = bind_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("broker listening on http://{addr}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

async fn get_defconfigs(State(st): State<AppState>) -> Response {
    Json(st.defconfigs_list.as_ref().clone()).into_response()
}

#[derive(Deserialize)]
struct BuildReq {
    defconfig: String,
}

/// Real client IP: trust a configured proxy header (first hop of XFF) if set,
/// otherwise the socket peer.
fn client_ip(headers: &HeaderMap, peer: SocketAddr, ip_header: &Option<String>) -> String {
    if let Some(h) = ip_header {
        if let Some(v) = headers.get(h.as_str()) {
            if let Ok(s) = v.to_str() {
                if let Some(first) = s.split(',').next() {
                    let t = first.trim();
                    if !t.is_empty() {
                        return t.to_string();
                    }
                }
            }
        }
    }
    peer.ip().to_string()
}

async fn post_build(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<BuildReq>,
) -> Response {
    let defconfig = req.defconfig.trim().to_string();
    if !st.defconfigs.contains(&defconfig) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unknown defconfig"})),
        )
            .into_response();
    }

    let ip = client_ip(&headers, peer, &st.ip_header);
    let build_id = uuid::Uuid::new_v4().to_string();
    let now = now_secs();
    let cutoff = now - WINDOW_SECS;

    // Rate-limit + reserve the slot atomically. The guard is dropped at the end
    // of this block, before any `.await`, so the future stays Send.
    {
        let conn = st.db.lock().unwrap();
        let global: i64 = conn
            .query_row("SELECT count(*) FROM builds WHERE ts > ?1", [cutoff], |r| {
                r.get(0)
            })
            .unwrap_or(0);
        if global >= st.global_limit {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": "global hourly build limit reached, try again later"})),
            )
                .into_response();
        }
        let per_ip: i64 = conn
            .query_row(
                "SELECT count(*) FROM builds WHERE ts > ?1 AND ip = ?2",
                rusqlite::params![cutoff, ip],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if per_ip >= st.per_ip_limit {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error": "per-IP hourly build limit reached, try again later"})),
            )
                .into_response();
        }
        if let Err(e) = conn.execute(
            "INSERT INTO builds(id, ip, defconfig, ts) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![build_id, ip, defconfig, now],
        ) {
            tracing::error!("db insert failed: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "internal error"})),
            )
                .into_response();
        }
    }

    // Fire repository_dispatch.
    let url = format!("https://api.github.com/repos/{}/dispatches", st.github_repo);
    let payload = json!({
        "event_type": "web-build",
        "client_payload": { "build_id": build_id, "defconfig": defconfig }
    });
    let resp = st
        .http
        .post(&url)
        .bearer_auth(&st.github_token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&payload)
        .send()
        .await;

    let dispatched = match resp {
        Ok(r) if r.status().is_success() => true,
        Ok(r) => {
            let code = r.status().as_u16();
            let body = r.text().await.unwrap_or_default();
            tracing::error!("dispatch rejected ({code}): {body}");
            false
        }
        Err(e) => {
            tracing::error!("dispatch error: {e}");
            false
        }
    };

    if !dispatched {
        // Don't charge the user's quota for a build that never started.
        let conn = st.db.lock().unwrap();
        let _ = conn.execute("DELETE FROM builds WHERE id = ?1", rusqlite::params![build_id]);
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": "failed to dispatch build"})),
        )
            .into_response();
    }

    let download_url = asset_url(&st, &build_id);
    tracing::info!("dispatched build {build_id} ({defconfig}) for {ip}");
    (
        StatusCode::ACCEPTED,
        Json(json!({
            "build_id": build_id,
            "defconfig": defconfig,
            "status_url": format!("/api/status/{build_id}"),
            "download_url": download_url,
        })),
    )
        .into_response()
}

async fn get_status(State(st): State<AppState>, Path(build_id): Path<String>) -> Response {
    if !valid_build_id(&build_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "bad build_id"})),
        )
            .into_response();
    }
    let download_url = asset_url(&st, &build_id);
    // Cheap HEAD against the public release CDN — no token needed, no GitHub API
    // rate limit, no browser CORS headache.
    let ready = match st.http.head(&download_url).send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    };
    Json(json!({
        "ready": ready,
        "download_url": if ready { Some(download_url) } else { None },
    }))
    .into_response()
}

fn asset_url(st: &AppState, build_id: &str) -> String {
    format!(
        "https://github.com/{}/releases/download/{}/{}.bin",
        st.github_repo, st.rolling_tag, build_id
    )
}
