use std::{process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct ServerProcess(Mutex<Option<Child>>);

fn launch_server(app: &tauri::AppHandle) -> Result<Child, Box<dyn std::error::Error>> {
    let server_dir = app.path().resource_dir()?.join("server");
    let child = Command::new("node")
        .arg("server.js")
        .current_dir(server_dir)
        .env("PORT", "3000")
        .env("HOSTNAME", "127.0.0.1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let child = launch_server(app.handle())?;
                *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
                std::thread::sleep(std::time::Duration::from_millis(850));
            }

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External("http://127.0.0.1:3000".parse().unwrap()),
            )
            .title("J.A.R.V.I.S.")
            .inner_size(1180.0, 760.0)
            .min_inner_size(900.0, 620.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .resizable(true)
            .shadow(false)
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Jarvis");

    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}

