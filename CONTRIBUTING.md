# Contributing

Thanks for helping improve Linka.

Linka is an open-source local desktop runtime project aimed at agent builders, desktop automation developers, and contributors interested in safer human-in-the-loop workflows. Contributions are welcome across code, UX, docs, examples, and platform validation.

## Who Should Contribute

Linka welcomes contributions from:

- agent builders
- desktop automation developers
- open-source contributors
- UX and interaction designers
- documentation contributors

## Good Contribution Areas

High-value contribution areas include:

- MCP server design and implementation
- Codex Skill interoperability research
- Linux Wayland support
- Windows Teach support
- cross-platform testing and validation
- documentation and example workflows
- approval workflow design
- packaging and release quality

If you are not sure where to start, documentation, examples, and platform validation are all useful.

## Issues

Open an issue for:

- bugs
- setup problems
- platform compatibility reports
- architecture questions
- documentation improvements
- feature ideas related to local agent workflows

Useful issue details:

- what you expected to happen
- what actually happened
- platform and OS version
- whether you ran a packaged build or development mode
- screenshots, logs, or reproduction steps when available

## Pull Requests

Before opening a pull request:

- keep the change scoped and reviewable
- explain the motivation, especially if the change affects architecture or trust boundaries
- describe how you tested it
- run `npm run lint` if the change touches code
- avoid committing generated output such as `dist`, `dist_electron`, `node_modules`, or native `bin/obj` folders

Small, clear pull requests are easiest to review and merge.

## Documentation Matters

Linka is still clarifying its public architecture and agent-facing story. Good documentation changes are first-class contributions.

Helpful docs contributions include:

- setup guides
- architecture clarifications
- platform notes
- screenshots
- example Teach workflows
- future MCP and skill-design proposals

## OpenAI Ecosystem Direction

If you want to contribute in an ecosystem-aligned way, focus on work that helps Linka move toward:

- MCP-compatible tool and context exposure
- reusable workflow packaging
- human-in-the-loop approval models
- safer local desktop execution

Please do not present roadmap items as already implemented. The repo should stay technically honest about what exists today and what is still being explored.
