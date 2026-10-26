use serde::Serialize;
use std::process::Command;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

#[derive(Serialize)]
struct NowPlaying {
    track: String,
    artist: String,
    source: String,
}

fn is_running(process: &str) -> bool {
    Command::new("pgrep")
        .args(["-x", process])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ask_player(app_name: &str) -> Option<(String, String)> {
    // Only talk to the player if it's already open, so we never launch it.
    let script = format!(
        r#"tell application "{app}"
    if player state is playing then
        return (name of current track) & "|||" & (artist of current track)
    end if
end tell
return """#,
        app = app_name
    );
    let out = Command::new("osascript").args(["-e", &script]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let (track, artist) = text.split_once("|||")?;
    if track.is_empty() {
        return None;
    }
    Some((track.to_string(), artist.to_string()))
}

/// What's playing in Spotify or Apple Music right now, if anything.
#[tauri::command]
async fn now_playing() -> Option<NowPlaying> {
    for (process, app_name, label) in [("Spotify", "Spotify", "Spotify"), ("Music", "Music", "Apple Music")] {
        if is_running(process) {
            if let Some((track, artist)) = ask_player(app_name) {
                return Some(NowPlaying {
                    track,
                    artist,
                    source: label.to_string(),
                });
            }
        }
    }
    None
}

/// Seconds since the last keyboard or mouse input on this Mac.
#[tauri::command]
async fn idle_seconds() -> Option<u64> {
    let out = Command::new("ioreg")
        .args(["-c", "IOHIDSystem", "-d", "4"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        if line.contains("\"HIDIdleTime\"") {
            let value = line.rsplit('=').next()?.trim();
            let nanos: u64 = value.parse().ok()?;
            return Some(nanos / 1_000_000_000);
        }
    }
    None
}

fn toggle_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.move_window(Position::TrayCenter);
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![now_playing, idle_seconds])
        .setup(|app| {
            // Menu bar only: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Real macOS frosted glass behind the panel, with rounded corners.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    Some(24.0),
                );
            }

            let open = MenuItem::with_id(app, "open", "Open Lifescale HQ", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

            let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;

            TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Lifescale HQ")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => toggle_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            // Open the panel on first launch so the morning check-in shows up.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(600));
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || toggle_panel(&h));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Click anywhere else and the panel tucks itself away.
            if let WindowEvent::Focused(false) = event {
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lifescale HQ");
}
