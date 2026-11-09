//! The three Discord desktop branches the installer knows about.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Branch {
    Stable,
    Ptb,
    Canary,
}

impl Branch {
    pub const ALL: [Branch; 3] = [Branch::Stable, Branch::Ptb, Branch::Canary];

    /// The id used in the API, in step names and by the Vencord CLI's `-branch` flag.
    pub fn id(self) -> &'static str {
        match self {
            Branch::Stable => "stable",
            Branch::Ptb => "ptb",
            Branch::Canary => "canary",
        }
    }

    /// The folder under %LOCALAPPDATA% that Discord's Squirrel installer uses.
    pub fn dir_name(self) -> &'static str {
        match self {
            Branch::Stable => "Discord",
            Branch::Ptb => "DiscordPTB",
            Branch::Canary => "DiscordCanary",
        }
    }

    /// The main process image name.
    pub fn exe(self) -> &'static str {
        match self {
            Branch::Stable => "Discord.exe",
            Branch::Ptb => "DiscordPTB.exe",
            Branch::Canary => "DiscordCanary.exe",
        }
    }

    /// A human name for the UI and logs.
    pub fn label(self) -> &'static str {
        match self {
            Branch::Stable => "Discord",
            Branch::Ptb => "Discord PTB",
            Branch::Canary => "Discord Canary",
        }
    }

    pub fn parse(s: &str) -> Option<Branch> {
        match s.trim().to_ascii_lowercase().as_str() {
            "stable" | "discord" => Some(Branch::Stable),
            "ptb" | "discordptb" => Some(Branch::Ptb),
            "canary" | "discordcanary" => Some(Branch::Canary),
            _ => None,
        }
    }
}

impl std::fmt::Display for Branch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id())
    }
}
