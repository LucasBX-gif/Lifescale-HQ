use serde::Serialize;
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewWindow, WindowEvent,
};

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


/* ---------- layout state ---------- */

/// The bar is wide and short and sits just under the menu bar (or next to the mini widget).
const BAR_MAX_WIDTH: f64 = 920.0;
const BAR_HEIGHT: u32 = 156;
const BAR_MAX_TALL: u32 = 560;
const BELOW_MENU_BAR: f64 = 42.0;
const MINI_W: f64 = 520.0;
const MINI_H: f64 = 64.0;
const EDGE: f64 = 12.0;

/// The bar grows taller for the calendar, then shrinks back.
static BAR_H: AtomicU32 = AtomicU32::new(BAR_HEIGHT);
/// Mini widget pinned on screen.
static PINNED: AtomicBool = AtomicBool::new(false);
/// Full bar currently open.
static EXPANDED: AtomicBool = AtomicBool::new(false);
/// Where the mini widget sits (logical px), stored as f64 bits. NaN = not set yet.
static MINI_X: AtomicU64 = AtomicU64::new(0x7ff8_0000_0000_0000);
static MINI_Y: AtomicU64 = AtomicU64::new(0x7ff8_0000_0000_0000);
/// Where you dragged the full bar to (logical px). NaN = default spot under the menu bar.
static BAR_X: AtomicU64 = AtomicU64::new(0x7ff8_0000_0000_0000);
static BAR_Y: AtomicU64 = AtomicU64::new(0x7ff8_0000_0000_0000);
/// True while we're moving the window ourselves, so it isn't mistaken for a user drag.
static PLACING: AtomicBool = AtomicBool::new(false);
/// When the bar last closed by itself, so the same click on the menu bar icon doesn't reopen it.
static LAST_AUTO_HIDE_MS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn mini_pos() -> Option<(f64, f64)> {
    let x = f64::from_bits(MINI_X.load(Ordering::Relaxed));
    let y = f64::from_bits(MINI_Y.load(Ordering::Relaxed));
    if x.is_nan() || y.is_nan() {
        None
    } else {
        Some((x, y))
    }
}

fn bar_pos() -> Option<(f64, f64)> {
    let x = f64::from_bits(BAR_X.load(Ordering::Relaxed));
    let y = f64::from_bits(BAR_Y.load(Ordering::Relaxed));
    if x.is_nan() || y.is_nan() {
        None
    } else {
        Some((x, y))
    }
}

fn set_bar_pos(x: f64, y: f64) {
    BAR_X.store(x.to_bits(), Ordering::Relaxed);
    BAR_Y.store(y.to_bits(), Ordering::Relaxed);
}

fn set_mini_pos(x: f64, y: f64) {
    MINI_X.store(x.to_bits(), Ordering::Relaxed);
    MINI_Y.store(y.to_bits(), Ordering::Relaxed);
}

/// Logical (x, y, width, height) of the screen the window is on.
fn screen_of(window: &WebviewWindow) -> Option<(f64, f64, f64, f64)> {
    let m = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let s = m.scale_factor();
    let size = m.size().to_logical::<f64>(s);
    let pos = m.position().to_logical::<f64>(s);
    Some((pos.x, pos.y, size.width, size.height))
}

/// Full bar: under the menu bar, or anchored to the mini widget when it's pinned.
fn place_bar(window: &WebviewWindow) {
    let Some((sx, sy, sw, sh)) = screen_of(window) else { return };
    let width = BAR_MAX_WIDTH.min(sw - 2.0 * EDGE);
    let height = BAR_H.load(Ordering::Relaxed) as f64;
    let (mut x, mut y) = (sx + (sw - width) / 2.0, sy + BELOW_MENU_BAR);
    if let Some((bx, by)) = bar_pos() {
        // You dragged it somewhere: keep it there.
        x = bx;
        y = by;
    } else if PINNED.load(Ordering::Relaxed) {
        if let Some((mx, my)) = mini_pos() {
            x = mx + MINI_W / 2.0 - width / 2.0;
            y = my;
        }
    }
    x = x.clamp(sx + EDGE, sx + sw - width - EDGE);
    y = y.clamp(sy + 24.0, (sy + sh - height - EDGE).max(sy + 24.0));
    PLACING.store(true, Ordering::Relaxed);
    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(x, y));
    PLACING.store(false, Ordering::Relaxed);
}

/// Mini widget: where you last dragged it, or top right under the menu bar.
fn place_mini(window: &WebviewWindow) {
    let Some((sx, sy, sw, sh)) = screen_of(window) else { return };
    let (x, y) = mini_pos().unwrap_or((sx + sw - MINI_W - 16.0, sy + BELOW_MENU_BAR));
    let x = x.clamp(sx, sx + sw - MINI_W);
    let y = y.clamp(sy + 24.0, sy + sh - MINI_H);
    set_mini_pos(x, y);
    PLACING.store(true, Ordering::Relaxed);
    let _ = window.set_size(LogicalSize::new(MINI_W, MINI_H));
    let _ = window.set_position(LogicalPosition::new(x, y));
    PLACING.store(false, Ordering::Relaxed);
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

        panel_event!(BarEvents {
            window_did_resign_key(notification: &NSNotification) -> (),
            window_did_move(notification: &NSNotification) -> ()
        })
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

        let events = BarEvents::new();
        // Clicked anywhere else: close the bar (or shrink back to the mini widget).
        let h = app.clone();
        events.window_did_resign_key(move |_| {
            let h2 = h.clone();
            let _ = h.run_on_main_thread(move || super::on_click_away(&h2));
        });
        // Dragged the mini widget: remember where.
        let h = app.clone();
        events.window_did_move(move |_| super::on_moved(&h));
        panel.set_event_handler(Some(events.as_ref()));
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

    pub fn is_open(app: &AppHandle) -> bool {
        app.get_webview_panel("main").map(|p| p.is_visible()).unwrap_or(false)
    }
    pub fn show_key(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("main") {
            p.show_and_make_key();
        }
    }
    pub fn show(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("main") {
            p.show();
        }
    }
    pub fn hide(app: &AppHandle) {
        if let Ok(p) = app.get_webview_panel("main") {
            p.hide();
        }
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
}

fn is_open(app: &AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    return mac::is_open(app);
    #[cfg(not(target_os = "macos"))]
    return app.get_webview_window("main").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
}

fn show_window(app: &AppHandle, key: bool) {
    #[cfg(target_os = "macos")]
    {
        if key {
            mac::show_key(app)
        } else {
            mac::show(app)
        }
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        if key {
            let _ = w.set_focus();
        }
    }
}

fn hide_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    mac::hide(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

/// Open the full bar.
fn expand(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    EXPANDED.store(true, Ordering::Relaxed);
    let _ = app.emit_to("main", "layout", "bar");
    place_bar(&window);
    show_window(app, true);
    let _ = app.emit_to("main", "bar-shown", ());
}

/// Close the full bar: back to the mini widget if it's pinned, otherwise hide.
fn collapse(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    EXPANDED.store(false, Ordering::Relaxed);
    if PINNED.load(Ordering::Relaxed) {
        let _ = app.emit_to("main", "layout", "mini");
        place_mini(&window);
        show_window(app, false);
    } else {
        hide_window(app);
    }
}

fn toggle_bar(app: &AppHandle) {
    if EXPANDED.load(Ordering::Relaxed) && is_open(app) {
        collapse(app);
        return;
    }
    if now_ms().saturating_sub(LAST_AUTO_HIDE_MS.load(Ordering::Relaxed)) < 350 {
        return;
    }
    expand(app);
}

fn on_click_away(app: &AppHandle) {
    if EXPANDED.load(Ordering::Relaxed) {
        LAST_AUTO_HIDE_MS.store(now_ms(), Ordering::Relaxed);
        collapse(app);
    }
}

fn on_moved(app: &AppHandle) {
    if PLACING.load(Ordering::Relaxed) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let (Ok(pos), Ok(scale)) = (window.outer_position(), window.scale_factor()) else { return };
    let p = pos.to_logical::<f64>(scale);
    if EXPANDED.load(Ordering::Relaxed) {
        set_bar_pos(p.x, p.y);
        let _ = app.emit_to("main", "bar-moved", (p.x, p.y));
    } else if PINNED.load(Ordering::Relaxed) {
        set_mini_pos(p.x, p.y);
        let _ = app.emit_to("main", "mini-moved", (p.x, p.y));
    }
}

/* ---------- commands ---------- */

/// Resize the bar (taller for the calendar).
#[tauri::command]
fn set_bar_height(app: AppHandle, height: u32) {
    BAR_H.store(height.clamp(BAR_HEIGHT, BAR_MAX_TALL), Ordering::Relaxed);
    if EXPANDED.load(Ordering::Relaxed) {
        if let Some(window) = app.get_webview_window("main") {
            place_bar(&window);
        }
    }
}

/// Turn the floating mini widget on or off. x/y restore where it was last dragged.
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool, x: Option<f64>, y: Option<f64>) {
    PINNED.store(pinned, Ordering::Relaxed);
    if let (Some(x), Some(y)) = (x, y) {
        set_mini_pos(x, y);
    }
    if !EXPANDED.load(Ordering::Relaxed) {
        collapse(&app);
    }
}

/// Restore where you last dragged the full bar, or pass nothing to snap it back under the menu bar.
#[tauri::command]
fn set_bar_position(app: AppHandle, x: Option<f64>, y: Option<f64>) {
    match (x, y) {
        (Some(x), Some(y)) => set_bar_pos(x, y),
        _ => set_bar_pos(f64::NAN, f64::NAN),
    }
    if EXPANDED.load(Ordering::Relaxed) {
        if let Some(window) = app.get_webview_window("main") {
            place_bar(&window);
        }
    }
}

/// Esc, or the widget's expand button.
#[tauri::command]
fn dismiss(app: AppHandle) {
    if EXPANDED.load(Ordering::Relaxed) {
        collapse(&app);
    }
}

#[tauri::command]
fn expand_bar(app: AppHandle) {
    expand(&app);
}

struct TrayItems {
    flow: MenuItem<tauri::Wry>,
    pin: MenuItem<tauri::Wry>,
}

/// Live flow time next to the menu bar icon (None clears it), and the menu's labels.
#[tauri::command]
fn set_tray_state(app: AppHandle, title: Option<String>, flowing: bool, pinned: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_title(title);
    }
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.flow.set_text(if flowing { "End flow" } else { "Start flow" });
        let _ = items.pin.set_text(if pinned { "Hide mini widget" } else { "Show mini widget" });
    }
}

/// Open at login on/off. Returns the current setting.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: Option<bool>) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    match enabled {
        Some(true) => {
            let _ = al.enable();
        }
        Some(false) => {
            let _ = al.disable();
        }
        None => {}
    }
    al.is_enabled().unwrap_or(false)
}

/// Cover the whole screen the bar is on with the celebration overlay and play it.
#[tauri::command]
fn celebrate(app: AppHandle, payload: serde_json::Value) {
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
fn fx_done(app: AppHandle) {
    #[cfg(target_os = "macos")]
    mac::hide_fx(&app);
    #[cfg(not(target_os = "macos"))]
    if let Some(fx) = app.get_webview_window("fx") {
        let _ = fx.hide();
    }
}

/* ---------- app ---------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![
            now_playing,
            idle_seconds,
            celebrate,
            fx_done,
            set_bar_height,
            set_pinned,
            dismiss,
            expand_bar,
            set_tray_state,
            set_autostart,
            set_bar_position
        ])
        .setup(|app| {
            // Menu bar only: no Dock icon.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "macos")]
            {
                mac::make_panel(app.handle());
                mac::make_fx_panel(app.handle());
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(fx) = app.get_webview_window("fx") {
                let _ = fx.set_ignore_cursor_events(true);
            }

            // ⌥⇧Space opens the bar from anywhere. If another app already owns it, skip quietly.
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                let _ = app.global_shortcut().on_shortcut("Alt+Shift+Space", |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let h = app.clone();
                        let _ = app.run_on_main_thread(move || toggle_bar(&h));
                    }
                });
            }

            let flow = MenuItem::with_id(app, "flow", "Start flow", true, None::<&str>)?;
            let win = MenuItem::with_id(app, "win", "Log a win", true, None::<&str>)?;
            let pin = MenuItem::with_id(app, "pin", "Show mini widget", true, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Lifescale HQ   ⌥⇧Space", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&flow, &win, &sep1, &pin, &open, &sep2, &quit])?;
            app.manage(TrayItems { flow: flow.clone(), pin: pin.clone() });

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
                    other => {
                        let _ = app.emit_to("main", "tray-action", other.to_string());
                    }
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
                let _ = handle.run_on_main_thread(move || expand(&h));
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Non-macOS fallback (on macOS the panel's own events handle this).
            if window.label() != "main" {
                return;
            }
            match event {
                WindowEvent::Focused(false) => on_click_away(window.app_handle()),
                WindowEvent::Moved(_) => on_moved(window.app_handle()),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Lifescale HQ");
}
