use std::{
    env,
    hint::black_box,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use deadpool_postgres::{Config as PostgresPoolConfig, Pool, PoolConfig, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{net::TcpListener, task, time::sleep};
use tokio_postgres::NoTls;

#[derive(Clone)]
struct AppState {
    pool: Pool,
    async_workers: usize,
}

#[derive(Serialize)]
struct FastResponse {
    ok: bool,
    runtime: &'static str,
    async_workers: usize,
    acquire_ms: f64,
    db_round_trip_ms: f64,
    handler_ms: f64,
}

#[derive(Deserialize)]
struct CpuQuery {
    #[serde(default = "default_cpu_ms")]
    ms: u64,
    #[serde(default = "default_delay_ms")]
    delay_ms: u64,
    #[serde(default)]
    mode: CpuMode,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CpuMode {
    #[default]
    Inline,
    Offloaded,
}

fn default_cpu_ms() -> u64 {
    2_000
}

fn default_delay_ms() -> u64 {
    150
}

/// Deliberately synchronous CPU work. Calling this on a Tokio async worker is the fault.
fn burn_cpu(milliseconds: u64) {
    let deadline = Instant::now() + Duration::from_millis(milliseconds);
    let mut value = 0_u64;
    while Instant::now() < deadline {
        value = black_box(value.wrapping_mul(1_664_525).wrapping_add(1_013_904_223));
    }
    black_box(value);
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "ok": true, "runtime": "rust-tokio", "asyncWorkers": state.async_workers }))
}

async fn fast(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FastResponse>, (StatusCode, String)> {
    let handler_started = Instant::now();
    let acquiring = Instant::now();
    let client = state
        .pool
        .get()
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error.to_string()))?;
    let acquire_ms = acquiring.elapsed().as_secs_f64() * 1_000.0;

    let querying = Instant::now();
    client
        .query_one("SELECT 1", &[])
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error.to_string()))?;
    let db_round_trip_ms = querying.elapsed().as_secs_f64() * 1_000.0;

    Ok(Json(FastResponse {
        ok: true,
        runtime: "rust-tokio",
        async_workers: state.async_workers,
        acquire_ms,
        db_round_trip_ms,
        handler_ms: handler_started.elapsed().as_secs_f64() * 1_000.0,
    }))
}

async fn schedule_cpu(
    Query(query): Query<CpuQuery>,
    State(state): State<Arc<AppState>>,
) -> Result<(StatusCode, Json<Value>), (StatusCode, String)> {
    if query.ms > 5_000 || !(50..=1_000).contains(&query.delay_ms) {
        return Err((
            StatusCode::BAD_REQUEST,
            "ms must be <= 5000 and delay_ms must be 50..1000".into(),
        ));
    }

    let mode = query.mode;
    tokio::spawn(async move {
        sleep(Duration::from_millis(query.delay_ms)).await;
        match mode {
            // Bad: no .await occurs while this loop occupies a Tokio core worker.
            CpuMode::Inline => burn_cpu(query.ms),
            // Good: the async worker remains free while a blocking-pool thread owns the CPU loop.
            CpuMode::Offloaded => {
                let _ = task::spawn_blocking(move || burn_cpu(query.ms)).await;
            }
        }
    });

    let mode_name = match mode {
        CpuMode::Inline => "inline",
        CpuMode::Offloaded => "offloaded",
    };
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "mode": mode_name,
            "blockForMs": query.ms,
            "scheduledInMs": query.delay_ms,
            "asyncWorkers": state.async_workers
        })),
    ))
}

async fn run(async_workers: usize) {
    let mut config = PostgresPoolConfig::new();
    config.host = Some(env::var("PGHOST").unwrap_or_else(|_| "127.0.0.1".into()));
    config.port = Some(
        env::var("PGPORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(5_643),
    );
    config.user = Some(env::var("PGUSER").unwrap_or_else(|_| "lab".into()));
    config.password = Some(env::var("PGPASSWORD").unwrap_or_else(|_| "lab-local-only".into()));
    config.dbname = Some(env::var("PGDATABASE").unwrap_or_else(|_| "lab".into()));
    config.application_name = Some(format!("rust-queue-lab-{async_workers}-workers"));
    config.pool = Some(PoolConfig::new(10));

    let pool = config
        .create_pool(Some(Runtime::Tokio1), NoTls)
        .expect("create PostgreSQL pool");
    let state = Arc::new(AppState {
        pool,
        async_workers,
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/fast", get(fast))
        .route("/cpu-scheduled", get(schedule_cpu))
        .with_state(state);
    let listener = TcpListener::bind("0.0.0.0:3000")
        .await
        .expect("bind HTTP listener");
    println!("Rust/Tokio lab listening on 3000 with {async_workers} async workers");
    axum::serve(listener, app).await.expect("serve HTTP");
}

fn main() {
    let async_workers = env::var("RUST_ASYNC_WORKERS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2);
    assert!(async_workers > 0, "RUST_ASYNC_WORKERS must be positive");

    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(async_workers)
        .enable_all()
        .build()
        .expect("build Tokio runtime")
        .block_on(run(async_workers));
}
