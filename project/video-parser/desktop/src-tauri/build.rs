fn main() {
    tauri_build::build();
    if std::env::var_os("CARGO_FEATURE_TEAM_SMOKE").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("examples/team-smoke.manifest");
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}",
            manifest.display()
        );
        println!("cargo:rerun-if-changed=examples/team-smoke.manifest");
    }
}
