//! Progress reporting: the events the UI listens to, and a recorder for tests.

use std::sync::Mutex;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Active,
    Done,
    Skipped,
    Error,
}

/// The `progress` event payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProgressEvent {
    /// "close", "fetch-installer", "fetch-build", "place", "patch:stable", "start", ...
    pub step: String,
    pub state: StepState,
    pub detail: String,
    /// Overall progress of the whole operation, 0 to 100.
    pub pct: f64,
}

/// One entry of the `plan` event payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlanStep {
    pub id: String,
    pub label: String,
}

pub trait Reporter: Send + Sync {
    fn plan(&self, steps: &[PlanStep]);
    fn progress(&self, ev: &ProgressEvent);
    fn log(&self, line: &str);
}

/// Keeps every event in memory.
#[derive(Default)]
pub struct Recorder {
    pub plans: Mutex<Vec<Vec<PlanStep>>>,
    pub events: Mutex<Vec<ProgressEvent>>,
    pub lines: Mutex<Vec<String>>,
}

impl Reporter for Recorder {
    fn plan(&self, steps: &[PlanStep]) {
        self.plans.lock().unwrap().push(steps.to_vec());
    }
    fn progress(&self, ev: &ProgressEvent) {
        self.events.lock().unwrap().push(ev.clone());
    }
    fn log(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_string());
    }
}

impl Recorder {
    /// The last state each step reached.
    pub fn final_states(&self) -> Vec<(String, StepState)> {
        let mut out: Vec<(String, StepState)> = Vec::new();
        for ev in self.events.lock().unwrap().iter() {
            match out.iter_mut().find(|(s, _)| *s == ev.step) {
                Some(entry) => entry.1 = ev.state,
                None => out.push((ev.step.clone(), ev.state)),
            }
        }
        out
    }
}

/// Turns step updates into `progress` events with an overall percentage, and
/// keeps the full log for the failure report.
pub struct Tracker<'a> {
    rep: &'a dyn Reporter,
    steps: Vec<(String, f64)>,
    total: f64,
    lines: Mutex<Vec<String>>,
    last_pct: Mutex<f64>,
}

impl<'a> Tracker<'a> {
    /// `plan`: (id, label, weight) per step, in order.
    pub fn new(rep: &'a dyn Reporter, plan: Vec<(String, String, f64)>) -> Self {
        let steps: Vec<PlanStep> =
            plan.iter().map(|(id, label, _)| PlanStep { id: id.clone(), label: label.clone() }).collect();
        rep.plan(&steps);
        let total = plan.iter().map(|(_, _, w)| *w).sum::<f64>().max(1.0);
        Tracker {
            rep,
            steps: plan.into_iter().map(|(id, _, w)| (id, w)).collect(),
            total,
            lines: Mutex::new(Vec::new()),
            last_pct: Mutex::new(-1.0),
        }
    }

    pub fn log(&self, line: &str) {
        self.lines.lock().unwrap().push(line.to_string());
        self.rep.log(line);
    }

    pub fn full_log(&self) -> String {
        self.lines.lock().unwrap().join("\n")
    }

    fn pct(&self, id: &str, frac: f64) -> f64 {
        let mut before = 0.0;
        for (sid, w) in &self.steps {
            if sid == id {
                let p = (before + w * frac.clamp(0.0, 1.0)) / self.total * 100.0;
                return (p * 10.0).round() / 10.0;
            }
            before += w;
        }
        0.0
    }

    fn emit(&self, id: &str, state: StepState, detail: &str, frac: f64) {
        let pct = self.pct(id, frac);
        *self.last_pct.lock().unwrap() = pct;
        self.rep.progress(&ProgressEvent { step: id.to_string(), state, detail: detail.to_string(), pct });
    }

    pub fn active(&self, id: &str, detail: &str) {
        self.emit(id, StepState::Active, detail, 0.0);
    }

    /// An in-step update; throttled to changes of at least half a percent.
    pub fn partial(&self, id: &str, frac: f64, detail: &str) {
        let pct = self.pct(id, frac);
        let last = *self.last_pct.lock().unwrap();
        if (pct - last).abs() >= 0.5 || frac >= 1.0 {
            self.emit(id, StepState::Active, detail, frac);
        }
    }

    pub fn done(&self, id: &str, detail: &str) {
        self.emit(id, StepState::Done, detail, 1.0);
    }

    pub fn skipped(&self, id: &str, detail: &str) {
        self.emit(id, StepState::Skipped, detail, 1.0);
    }

    pub fn error(&self, id: &str, detail: &str) {
        let pct = *self.last_pct.lock().unwrap();
        self.rep.progress(&ProgressEvent {
            step: id.to_string(),
            state: StepState::Error,
            detail: detail.to_string(),
            pct: pct.max(0.0),
        });
    }
}
