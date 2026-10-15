<!-- Generated from rule metadata by scripts/generate-docs.ts. Do not edit. -->

# `copilot/instructions-misplaced`

GitHub Copilot instructions file is not where Copilot looks for it.

|            |                                                     |
| ---------- | --------------------------------------------------- |
| Severity   | `error`                                             |
| Category   | `loading`                                           |
| Platforms  | GitHub Copilot                                      |
| Applies to | `copilot-instructions`, `copilot-path-instructions` |
| Fixable    | No                                                  |
| Since      | 2026.10                                             |

## Why

GitHub Copilot reads repository-wide instructions from `.github/copilot-instructions.md` and path-specific instructions from `*.instructions.md` files in `.github/instructions/` and its subdirectories, both at the repository root. A `copilot-instructions.md` anywhere else in `.github` is not loaded. In VS Code, the deprecated `chat.instructionsFilesLocations` setting can add other directories for the Local harness, so a misplaced `*.instructions.md` file is a warning.

A `.github` directory inside a subdirectory is not read on GitHub.com; VS Code reads it when you open that subdirectory as the workspace folder. A subdirectory with its own `.git` counts as a repository root. Only files inside a `.github` directory are checked, except `.github/workflows` and the `.github` directories of templates, examples and fixtures. A file that is also reachable through a symlink in the right place is not reported.

Move the file to `.github/copilot-instructions.md` or into `.github/instructions/`.

## Evidence

- [GitHub Copilot: Repository custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/add-custom-instructions/add-repository-instructions), verified, checked 2026-10-14
- [VS Code: Custom instructions](https://code.visualstudio.com/docs/agent-customization/custom-instructions), verified, checked 2026-10-14

## Configuration

```json
{
  "rules": {
    "copilot/instructions-misplaced": "off"
  }
}
```

Set the rule to `"off"`, `"info"`, `"warn"` or `"error"` in `agentcheck.config.json`, or
suppress one occurrence with a reason:

```markdown
<!-- agentcheck-disable-next-line copilot/instructions-misplaced -- reason -->
```
