fn main() {
    // asInvoker manifest: the installer only writes inside the user's profile,
    // so it must never trigger a UAC prompt (Windows' installer detection
    // would otherwise consider an exe named "*Setup*" for elevation).
    let windows = tauri_build::WindowsAttributes::new().app_manifest(include_str!("manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
