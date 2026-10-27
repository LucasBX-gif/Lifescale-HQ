use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent,
};

/// The bar is wide and short and sits just under the menu bar.
const BAR_MAX_WIDTH: f64 = 920.0;
const BAR_HEIGHT: f64 = 156.0;
const BELOW_MENU_BAR: f64 = 42.0;

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
/// Only asks a player that's already open, so it never launches one.
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

/// On macOS the bar is an NSPanel (like Spotlight or Raycast): it floats over
/// full-screen apps, shows on every desktop, and doesn't pull you out of the app you're in.
#[cfg(target_os = "macos")]
mod mac {
    use tauri::{AppHandle, Manager};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

    tauri_panel! {
        panel!(BarPanel {
            config: {
                can_become_key_window: true,
                is_floating_panel: true
            }
        })

        panel!(FxPanel {
            config: {
                can_become_key_window: false,
                is_floating_panel: true
            }
        })
    }

    /// The celebration overlay: above everything (even the bar), on every desktop, never takes focus.
    pub fn make_fx_panel(app: &AppHandle) {
        let Some(window) = app.get_webview_window("fx") else { return };
        let _ = window.set_ignore_cursor_events(true);
        let Ok(panel) = window.to_panel::<FxPanel>() else { return };
        panel.set_level(PanelLevel::PopUpMenu.value());
        let _ = panel.add_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .stationary()
                .ignores_cycle()
                .into(),
        );
    }

    pub fn show_fx(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("fx") {
            p.show();
        }
    }

    pub fn hide_fx(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("fx") {
            p.hide();
        }
    }

    pub fn make_panel(app: &AppHandle) {
        let Some(window) = app.get_webview_window("main") else { return };
        let Ok(panel) = window.to_panel::<BarPanel>() else { return };
        panel.set_level(PanelLevel::Status.value());
        let _ = panel.add_style_mask(StyleMask::empty().nonactivating_panel().into());
        panel.set_collection_behavior(
            CollectionBehavior::new()
                .full_screen_auxiliary()
                .can_join_all_spaces()
                .stationary()
                .into(),
        );
    }

    pub fn is_open(app: &AppHandle) -> bool {
        app.get_webview_panel("main").map(|p| p.is_visible()).unwrap_or(false)
    }

    pub fn show(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("main") {
            p.show_and_make_key();
        }
    }

    pub fn hide(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("main") {
            p.hide();
        }
    }
}

/// When the bar auto-hides because you clicked the menu bar icon, that same click
/// shouldn't instantly reopen it.
static LAST_AUTO_HIDE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Cover the whole screen the bar is on with the celebration overlay and play it.
#[tauri::command]
fn celebrate(app: tauri::AppHandle, payload: serde_json::Value) {
    let Some(fx) = app.get_webview_window("fx") else { return };
    let monitor = app
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| fx.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let _ = fx.set_position(*m.position());
        let _ = fx.set_size(*m.size());
    }
    let _ = fx.set_ignore_cursor_events(true);
    #[cfg(target_os = "macos")]
    mac::show_fx(&app);
    #[cfg(not(target_os = "macos"))]
    let _ = fx.show();
    let _ = app.emit_to("fx", "celebrate", payload);
}

/// The overlay finished playing.
#[tauri::command]
fn fx_done(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    mac::hide_fx(&app);
    #[cfg(not(target_os = "macos"))]
    if let Some(fx) = app.get_webview_window("fx") {
        let _ = fx.hide();
    }
}

/// Centre the bar at the top of whichever screen it's on, just under the menu bar.
fn place_bar(window: &WebviewWindow) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let width = BAR_MAX_WIDTH.min(size.width - 40.0);
    let _ = window.set_size(LogicalSize::new(width, BAR_HEIGHT));
    let _ = window.set_position(LogicalPosition::new(
        pos.x + (size.width - width) / 2.0,
        pos.y + BELOW_MENU_BAR,
    ));
}

fn toggle_bar(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };

    #[cfg(target_os = "macos")]
    let open = mac::is_open(app);
    #[cfg(not(target_os = "macos"))]
    let open = window.is_visible().unwrap_or(false);

    if open {
        #[cfg(target_os = "macos")]
        mac::hide(app);
        #[cfg(not(target_os = "macos"))]
        let _ = window.hide();
        return;
    }

    if now_ms().saturating_sub(LAST_AUTO_HIDE_MS.load(Ordering::Relaxed)) < 300 {
        return;
    }

    place_bar(&window);
    #[cfg(target_os = "macos")]
    mac::show(app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = window.emit("bar-shown", ());
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![now_playing, idle_seconds, celebrate, fx_done])
        .setup(|app| {
            // Menu bar only: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Real macOS frosted glass behind the bar, with pill-rounded corners.
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::HudWindow,
                    Some(NSVisualEffectState::Active),
                    Some(34.0),
                );
            }

            #[cfg(target_os = "macos")]
            {
                mac::make_panel(app.handle());
                mac::make_fx_panel(app.handle());
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(fx) = app.get_webview_window("fx") {
                let _ = fx.set_ignore_cursor_events(true);
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
                    "open" => toggle_bar(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_bar(tray.app_handle());
                    }
                })
                .build(app)?;

            // Drop the bar down on launch so the morning check-in shows up.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(700));
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || toggle_bar(&h));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Click anywhere else and the bar tucks itself away.
            if window.label() != "main" {
                return;
            }
            if let WindowEvent::Focused(false) = event {
                if window.is_visible().unwrap_or(false) {
                    LAST_AUTO_HIDE_MS.store(now_ms(), Ordering::Relaxed);
                }
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lifescale HQ");
}
