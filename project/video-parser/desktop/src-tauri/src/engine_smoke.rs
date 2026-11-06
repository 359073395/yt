//! Opt-in real ASR/API check. Reads existing model/API configuration, starts no
//! inbox or automation workers, and writes only a new caller-selected receipt.
use super::*;

pub fn run() {
    let input = PathBuf::from(std::env::args_os().nth(1).expect("test audio required"));
    assert!(input.is_file());
    let output = PathBuf::from(std::env::args_os().nth(2).expect("new receipt required"));
    let mut receipt = OpenOptions::new().create_new(true).write(true).open(output).unwrap();
    let exit = Arc::new(std::sync::atomic::AtomicI32::new(3));
    let final_exit = exit.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "org.yinglian.desktop.preview".into();
    context.config_mut().app.windows.clear();
    tauri::Builder::default().setup(move |app| {
        network::init(app.handle())?;
        let app = app.handle().clone();
        thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let state = RuntimeState {
                    processes: Arc::default(), cancelled: Arc::default(),
                    cancel_model: Arc::new(AtomicBool::new(false)),
                    model_root: Arc::new(RwLock::new(model_dir(&app)?)),
                    model_server_url: String::new(),
                };
                let request = DownloadRequest { job_id: uuid::Uuid::new_v4().to_string(), url: String::new(),
                    options: DownloadOptions { download_dir: String::new(), category: None, quality: "720".into(),
                        include_video: false, include_thumbnail: false, include_original_subtitle: false,
                        transcript_mode: "local".into(), language: "id".into(), model_id: "small".into() } };
                let (language, segments) = transcribe(&app, &state, &request, &input)?;
                writeln!(receipt, "ASR: {}", serde_json::json!({"language":language,"segments":segments})).map_err(|e|e.to_string())?;
                println!("ASR_PASS language={language} segments={}", segments.len());
                let (base, model, key) = saved_ai_credentials(&app)?;
                let texts = vec!["Produk ini ringan dan mudah digunakan.".into(), "Pilih warna favoritmu dan pesan sekarang.".into()];
                let translations = call_ai_translation(&base, &model, &key, &texts, "id")?;
                if translations.len()!=texts.len() || translations.iter().any(|t|!t.chars().any(|c|('\u{3400}'..='\u{9fff}').contains(&c))) {
                    return Err("API translation missing Chinese or wrong segment count".into());
                }
                writeln!(receipt, "API: {}", serde_json::json!({"source":texts,"translations":translations})).map_err(|e|e.to_string())?;
                println!("API_TRANSLATION_PASS segments={}", translations.len());
                Ok(())
            })();
            let code = match result { Ok(())=>0, Err(error)=>{ println!("ENGINE_FAIL {error}"); let _=writeln!(receipt,"FAIL: {error}"); 1 } };
            exit.store(code,Ordering::SeqCst); app.exit(code);
        }); Ok(())
    }).run(context).expect("engine acceptance application");
    process::exit(final_exit.load(Ordering::SeqCst));
}
