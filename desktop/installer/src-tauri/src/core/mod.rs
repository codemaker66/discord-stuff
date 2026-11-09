//! The installer itself, free of any Tauri types so `cargo test` can drive it.

pub mod asar;
pub mod branch;
pub mod cli;
pub mod detect;
pub mod env;
pub mod error;
pub mod fetch;
pub mod net;
pub mod ops;
pub mod place;
pub mod procs;
pub mod report;
pub mod sums;

pub use branch::Branch;
pub use detect::{Detection, InstallInfo, State};
pub use env::Env;
pub use error::{FailCode, OpError};
pub use ops::{Failure, InstallRequest, Summary, UninstallRequest};
pub use report::{PlanStep, ProgressEvent, Recorder, Reporter, StepState};
