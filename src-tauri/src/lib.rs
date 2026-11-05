pub mod accounts;
pub mod auth;
pub mod commands;
pub mod db;
pub mod emitter;
pub mod envsafe;
pub mod error;
pub mod git;
pub mod launch;
pub mod mcp;
pub mod metrics;
pub mod model;
pub mod paths;
pub mod protocol;
pub mod redact;
pub mod sandbox;
pub mod scheduler;
pub mod session;
pub mod state;
pub mod tracker;

use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("CCC_LOG").unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let st = state::AppState::bootstrap(app.handle().clone())?;
            app.manage(st.clone());
            tauri::async_runtime::spawn(state::metrics_loop(st.clone()));
            let st2 = st.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(c) = st2.claude.clone() {
                    if let Ok(Ok(o)) = tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        tokio::process::Command::new(&c.path).arg("--version").env_clear().env("PATH", "/usr/bin:/bin").output(),
                    )
                    .await
                    {
                        *st2.claude_version.write() = Some(String::from_utf8_lossy(&o.stdout).trim().to_string());
                    }
                }
                // Initial identity check for both accounts (no execution).
                for id in accounts::AccountId::ALL {
                    st2.ensure_auth(id, true).await;
                }
            });
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let WindowEvent::Destroyed = ev {
                if let Some(st) = w.app_handle().try_state::<std::sync::Arc<state::AppState>>() {
                    for id in accounts::AccountId::ALL {
                        st.db(id).flush();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_overview,
            commands::refresh_auth,
            commands::start_login,
            commands::login_input,
            commands::cancel_login,
            commands::list_repos,
            commands::repo_status,
            commands::repo_diff,
            commands::create_worktree,
            commands::list_sessions,
            commands::create_session,
            commands::send_message,
            commands::respond_approval,
            commands::interrupt_session,
            commands::stop_session,
            commands::archive_session,
            commands::set_session_priority,
            commands::get_session,
            commands::get_chat,
            commands::update_settings,
            commands::update_account,
            commands::get_metrics,
            commands::set_ui_visible,
            commands::list_tasks,
            commands::create_task,
            commands::update_task,
            commands::delete_task,
            commands::run_task,
            commands::list_external_sessions,
            commands::import_external_session,
            commands::list_projects,
            commands::save_project,
            commands::delete_project,
            commands::delete_session,
            commands::set_permission_mode,
            commands::mcp_list,
            commands::mcp_add,
            commands::mcp_remove,
            commands::mcp_login,
            commands::mcp_login_input,
            commands::mcp_login_cancel,
            commands::open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
