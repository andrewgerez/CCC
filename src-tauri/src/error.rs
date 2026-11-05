use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("isolation violation: {0}")]
    Isolation(String),
    #[error("path rejected: {0}")]
    Path(String),
    #[error("authentication blocked: {0}")]
    Auth(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("sandbox: {0}")]
    Sandbox(String),
    #[error("process: {0}")]
    Process(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Isolation(_) => "isolation",
            AppError::Path(_) => "path",
            AppError::Auth(_) => "auth",
            AppError::NotFound(_) => "not_found",
            AppError::Invalid(_) => "invalid",
            AppError::Sandbox(_) => "sandbox",
            AppError::Process(_) => "process",
            AppError::Db(_) => "db",
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
        }
    }
}

/// Errors cross the IPC boundary as `{code, message}`; messages are redacted.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &crate::redact::redact(&self.to_string()))?;
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
