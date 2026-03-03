# AquaClaw Snapshot Skill

This skill allows the AquaClaw agent to capture screenshots of the current macOS environment for UI verification and monitoring.

## Capabilities

- **Full Screen Capture:** Capture the entire desktop.
- **Window Capture:** Capture specific window if window ID is known (via standard macOS tools).
- **Automated Upload:** (Handled by AquaClaw engine) Files saved in `screenshots/` are automatically relayed to the Discord thread.

## Usage

The agent can run the following command via the `Bash` tool:

```bash
# Capture full screen
screencapture -x screenshots/$(date +%s).png

# Capture specific area (interactive mode - usually not for headless)
# screencapture -i screenshots/manual.png
```

## Implementation Notes

- Uses the native macOS `screencapture` utility.
- The `-x` flag is used to disable the capture sound.
- Screenshots are saved to the workspace's `screenshots/` directory.
- The AquaClaw engine monitors this directory and uploads new files to Discord.
