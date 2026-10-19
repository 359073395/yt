//! Read-only public-channel smoke: real updater download/signature, never install.
//! Windows examples need the Common Controls v6 manifest. Build with:
//! cargo rustc --example updater-download-smoke -- -C link-arg=/MANIFEST:EMBED
//!   -C link-arg=/MANIFESTINPUT:<absolute path to examples/team-smoke.manifest>
//! Run with <independently verified installer path> <new report path> [version].
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::Duration;
use std::io::Write;
use tauri_plugin_updater::UpdaterExt;

fn main() {
    let expected_version = std::env::args().nth(3).unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
    let expected = std::fs::read(std::env::args_os().nth(1).expect("verified installer path")).expect("read verified installer");
    let mut report = std::fs::OpenOptions::new().create_new(true).write(true).open(std::env::args_os().nth(2).expect("new QA report path")).expect("create QA report");
    writeln!(report, "Started: isolated read-only updater QA").unwrap();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "org.yinglian.update-download-qa".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            writeln!(report, "Native runtime ready").unwrap();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
                    let updater = handle.updater_builder()
                        .version_comparator(move |_, release| release.version.to_string() == expected_version)
                        .target("windows-x86_64-nsis")
                        .proxy("http://127.0.0.1:10808".parse()?)
                        .timeout(Duration::from_secs(30)).build()?;
                    let mut update = updater.check().await?.ok_or("expected version unavailable on public channel")?;
                    println!("Public channel: {}", update.version);
                    writeln!(report, "Public channel: {}", update.version)?;
                    update.timeout = Some(Duration::from_secs(900));
                    let progress = Arc::new(AtomicUsize::new(0));
                    let counter = progress.clone();
                    let started = std::time::Instant::now();
                    let bytes = update.download(move |size, _| { counter.fetch_add(size, Ordering::Relaxed); }, || {}).await?;
                    if bytes != expected || progress.load(Ordering::Relaxed) != bytes.len() { return Err("download differs from independently verified installer".into()); }
                    println!("PASS: native updater signature verified; {} bytes; {:.2}s; progress accounted; no installation", bytes.len(), started.elapsed().as_secs_f64());
                    writeln!(report, "PASS: native signature verified; {} bytes; {:.2}s; progress accounted; no installation", bytes.len(), started.elapsed().as_secs_f64())?;
                    Ok(())
                }.await;
                match result { Ok(()) => handle.exit(0), Err(error) => { let _ = writeln!(report, "FAIL: {error:?}"); handle.exit(1); } }
            });
            Ok(())
        })
        .run(context).expect("QA runtime");
}
