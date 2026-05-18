# Linka Teach Skill Prompt

Use this file as a human-readable prompt for a recorded Linka skill.

## Intent

Describe the outcome in one sentence.

Example:
`Minimize the Linka desktop window.`

## Target App

Name the app involved.

Example:
`Linka`

## Visible Context

Describe what should be visible on screen before acting.

Example:
`The Linka desktop window is open and focused. The top window controls are visible.`

Prefer end-state context over start-state context. If a screenshot is present, describe the UI state captured right after the recording stopped.

## Screenshot Reference

If there is a screenshot, add its path here.

Example:
`/Users/antoin/.linka/teach/screenshots/my-skill.png`

## Intended Action

Name the action Codex should try to resolve semantically.

Examples:
- `minimize_window`
- `focus_app`
- `open_known_folder`
- `confirm_dialog`
- `enter_text`

## Parameters

List any explicit parameters if needed.

Examples:
- `app_name: Linka`
- `text: hello world`
- `folder_name: Builds`
- `operands: 47, 98`

## Approval Rule

State the approval boundary clearly.

Example:
`Ask for approval before taking any desktop action. Do not replay raw clicks blindly.`

## Interpretation Rules For Codex

1. Read the intent first.
2. Confirm the target app.
3. Use the screenshot as end-state visual reference, not as a coordinate map.
4. Prefer explicit parameters extracted from the intent over guessing from click history.
5. Do not depend on coordinates.
6. Ask for approval before executing.

## Output Format

Codex should answer in this shape:

```text
Resolved action: <action_name or unresolved>
Why: <short reason>
Missing context: <none or what is still needed>
Safe next step: <what Codex should do next>
```

## Example

```md
# Linka Teach Skill Prompt

## Intent
Minimize the Linka desktop window.

## Target App
Linka

## Visible Context
The Linka desktop app is open and focused.

## Screenshot Reference
/Users/antoin/.linka/teach/screenshots/protocolo001.png

## Intended Action
minimize_window

## Parameters
app_name: Linka

## Approval Rule
Ask for approval before taking any desktop action. Do not replay raw clicks blindly.
```
