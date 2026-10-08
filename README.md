# Linebeam

**Key changes. Clear explanations.**

Linebeam is a desktop VS Code extension that turns code changes into guided
walkthroughs, with Copilot-powered explanations and highlighted evidence in
native diffs. It helps engineers understand code written by an agent.
Choose a Git scope, click **Explain Changes**, and follow a short reading
path through native before/after diffs. Each step explains what changed, why it
matters, and an optional question to investigate.

The explanations, evidence highlights, and navigation live in the editor UI.
Linebeam does not insert comments into your source, generate fixes, run your
tests, commit changes, or approve a pull request.

**Status:** early preview. The extension ID is `lukiiiz22.linebeam` and the
Marketplace title is **Linebeam - Guided Diff Walkthroughs**.

## Try it

Requirements: desktop VS Code **1.96 or newer**, Git on `PATH`, and Node.js
**22 or newer for development**. The extension bundle targets Node 20.

```powershell
npm ci
npm run build
```

Open this folder in VS Code and press **F5** using the **Run Linebeam** launch
configuration. In the new Extension Development Host:

1. Run **Linebeam: Try the Offline Demo** from the Command Palette, or use the
   demo button in the Linebeam activity-bar view.
2. Follow the native diffs with **Previous**, **Next**, and the evidence buttons.
   The demo includes an addition, a deletion, a rename, and an unsupported binary.
3. Open **All Changes** to see coverage and omissions.

The demo needs no Git repository, Copilot sign-in, model access, or network
request. It never changes workspace files.

For real changes, open **one local Git repository root** in the development
host. Choose the scope in the sidebar and click **Explain Changes**. On first
use, choose an available Copilot model and complete VS Code's consent flow.
Subsequent walkthroughs reuse your scope/model choice when available.

### Install the local VSIX

```powershell
npm run package
code --install-extension .\linebeam-0.1.2.vsix
```

You can also use **Extensions: Install from VSIX...**. Packaging does not publish
anything. `npm run package` builds the runtime and its third-party license
notices, then verifies the actual VSIX contents and extension identity against
the current build. Unexpected files, missing notices, and stale assets fail the
package check. The generated `dist/THIRD_PARTY_NOTICES.txt` is included in the
VSIX and covers direct and transitive packages actually bundled by esbuild.

The source repository is https://github.com/lukiiiz22/linebeam. The VSIX is
packaged as a Marketplace pre-release under the `lukiiiz22` publisher.

### Moving from the earlier DiffQuill preview

This is a clean pre-release rename. The extension ID is now
`lukiiiz22.linebeam`; commands, settings, and theme colors use `linebeam.*`.
Disable or uninstall the old DiffQuill or `linebeam-local.linebeam` preview
before installing Linebeam, and restart any earlier Extension Development Host
with **Run Linebeam**.

Rename any custom `diffquill.defaultScope` and `diffquill.excludeGlobs` settings
to `linebeam.defaultScope` and `linebeam.excludeGlobs`, preserving their values
and removing the old keys. Capture stops with an actionable error if old settings
remain explicitly configured, so a renamed extension cannot silently drop your
scope or privacy exclusions. Update custom keybindings and theme-color overrides
to the new prefix too. Old commands/settings are not aliases.

Choose the scope and Copilot model again on first use; the renamed extension has
separate saved preferences and VS Code model consent. In-memory walkthroughs
are not migrated. The internal read-only `diffquill:` document protocol remains
stable; it is not the extension's display name or command namespace.

## Exactly what is reviewed

Linebeam reviews an explicit Git comparison, **not "the last Copilot task."**
It has no access to the original coding conversation and cannot attribute edits
to an agent versus a person.

| Scope | Before | After | Non-ignored untracked files |
| --- | --- | --- | --- |
| **All local changes** | HEAD | Saved working tree | Included |
| **Staged only** | HEAD | Git index | Excluded |
| **Unstaged + untracked** | Git index | Saved working tree | Included |

In **All local changes**, a file with both staged and unstaged edits is compared
from HEAD to its current saved content. Its intermediate staged version is not
a separate walkthrough. Repositories with no commits use an empty baseline.
An index deletion whose file remains untracked is shown with explicit tracking
metadata in the all-local scope.

Unsaved buffers are **never included or saved automatically**. If there are
dirty file-backed editors, generation asks you to acknowledge this first.
Untitled buffers are outside the Git scope. Ignored untracked files are outside
the scope too; a tracked file remains in scope even if a Git ignore pattern
matches it.

The sidebar's **Next capture** controls can change without relabeling an
existing walkthrough. They collapse when a snapshot is captured; expand them to
change the scope/model or generate again. The view-title **Explain Changes**
button remains available as a shortcut. Captured scope and time remain in the
summary; **Snapshot details** contains the baseline, model, full timestamp,
snapshot ID, and capture caveats. Its bordered header and chevron indicate that
the whole row is expandable; both disclosures retain native keyboard behavior.

## Reading the walkthrough

- **Evidence buttons** open the relevant native diff, including old-side
  evidence for removals. Gold decorations highlight actual changed lines, not
  merely surrounding context. Hovering shows the current explanation.
- **Previous / Next** and the step counter stay in a fixed footer while the
  explanation scrolls. The sidebar and native editor toolbar agree on disabled
  first/last-step and busy states. Navigation uses the plan already in memory
  and does not make model requests.
- **All Changes** lists every captured file and hunk, including intentionally
  skipped changes, missing model coverage, context-budget omissions, metadata
  changes, conflicts, exclusions, and unsupported files.
- **Coverage badges are shortcuts** to unexplained hunks, unsupported files,
  skipped hunks, or metadata changes. Matching files expand to show their
  reasons, and the sidebar scrolls directly to the results. The active filter
  and result count remain visible while reading longer results. Re-selecting
  a filter brings its results back into view. Filters keep the complete
  coverage totals unchanged and always provide an **All changes** option.
  Unexplained hunks and file-level metadata are separate categories.
- **Explain Changes Again** captures a new snapshot and makes a new request.
  There are no automatic generation retries.
- **Clear Walkthrough** clears the current review. Already-open snapshot
  documents remain readable until their editors close.

Scrolling stays inside the sidebar rather than moving ancestor frames.
Keyboard focus follows an explicit coverage selection to its visible filter
control; background status updates do not move focus or reset reading position.

The model cites opaque hunk IDs and `old`/`new` sides. Linebeam checks the
snapshot identity, allowed IDs, side availability, output shape, text limits,
and derived line ranges before accepting the plan. Invalid output is rejected;
it is not presented as a successful explanation.

**An evidence link proves where an explanation points, not that the explanation
is correct.** "Explained" is a coverage state, not a test result or approval.
Linebeam never runs referenced tests.

### Changes made after capture

Both sides are read-only virtual documents containing the captured text. Neither
side is the live workspace file. Saving, staging, or modifying files cannot move
the highlights onto different code.

Changes to the saved comparison are checked before navigation, on relevant file
events, when the window regains focus, and approximately every 10 seconds while
the window is focused. New buffer edits also flag working-tree reviews. A stale
or unverified-freshness banner explains that you are still reading the earlier
capture; Linebeam does not regenerate or move focus automatically.

Snapshots and plans live **in memory for the current VS Code session**. They are
not written to your repository or persisted across reloads. Regenerate after
reloading the extension host.

## Copilot, privacy, and limits

Linebeam uses public `vscode.lm` APIs and discovers available models from the
`copilot` vendor at runtime. It does not hardcode a model family, accept a separate
OpenAI/Anthropic key, or operate an inference backend.

Each generation is a **new model request** containing selected UTF-8 diff hunks,
nearby context, repository-relative filenames, change metadata, and the output
contract. It does not inherit Copilot's coding chat. Usage, quotas, billing,
consent, and organization restrictions are governed by your applicable Copilot
access and VS Code. Permission denials, unavailable models, blocked requests,
stream failures, cancellation, and invalid responses are surfaced explicitly.

No telemetry or analytics is added by Linebeam. Logs contain operational error
messages, not intentionally recorded source snapshots, prompts, or model
responses. The sidebar has a restrictive Content Security Policy and does not
load remote scripts, styles, fonts, or images. Model prose is rendered as text,
not executable HTML or trusted Markdown.

**Review your scope and exclusions before clicking Explain Changes.** Default
exclusions cover `.env` variants, private-key/certificate formats, common SSH
private-key filenames, `.npmrc`, and `.pypirc`. They are a precaution, **not a
secret scanner**. Secrets in ordinary source files are not automatically
detected. Configure `linebeam.excludeGlobs` for your repository; changing that
array replaces the defaults, so retain any defaults you still want.

```json
{
  "linebeam.defaultScope": "all",
  "linebeam.excludeGlobs": [
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*.p12",
    "**/*.pfx",
    "**/id_rsa",
    "**/id_ed25519",
    "**/.npmrc",
    "**/.pypirc",
    "private/**"
  ]
}
```

Exclusion patterns are repository-relative globs; exclusions match both sides
of a rename. Excluded content is not captured or sent to the model, but the
filename and exclusion reason remain visible locally.

| Bound | Behavior |
| --- | --- |
| 200 changed files | Reject the whole scope if exceeded; never silently truncate it |
| 256 KiB per file side | Keep a visible unsupported-file entry |
| 8 MiB of captured text, both sides combined | Keep remaining files visible as unsupported |
| 400 text hunks | Files that exceed the remaining hunk budget remain visible |
| 1 second / 20,000 edits per file diff | Stop expensive diff computation and show an explicit omission |
| 75% of the model's input window, capped at 32,000 tokens | Include only complete hunks; label those not sent |
| 128 Ki characters of model response; 24 steps | Reject oversized or malformed responses |

Source hunks are budgeted ahead of test/documentation hunks and common lockfiles.
Budgeting is not semantic ranking; the model chooses the reading order from the
hunks it receives. A large hunk is not silently sliced into an incomplete
fragment.

Binary/non-UTF-8 files, symbolic links, submodules, and unresolved conflicts are
not analyzed. Pure renames, file modes, empty files, and line-ending-only changes
remain visible as file-level changes. Unstaged renames involving an untracked
destination may appear as a deletion and an addition, consistent with Git's
untracked-file behavior.

## Development

```powershell
npm run check
npm run test:integration
npm run package
npm run test:package
```

`npm run check` performs strict TypeScript checking, deterministic unit tests,
real temporary-repository tests, DOM-level sidebar interaction tests, and the
production bundle. There is no lint configuration to install separately.

The extension-host suite opens an isolated VS Code profile and temporary Git
repository. It exercises activation, native diff tabs, snapshot identity,
deletion evidence, navigation, visible omissions, real Git capture, freshness,
and clear state **without calling a live model**.

By default, the VS Code test runner downloads a stable test build. To use an
existing executable on Windows:

```powershell
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
npm run test:integration
```

On headless Linux, use `xvfb-run -a npm run test:integration`. CI runs unit and
packaging checks on Windows and Linux, plus the extension-host suite on Linux.
To run the same smoke suite against an unpacked VSIX, set
`LINEBEAM_EXTENSION_UNDER_TEST` to its `extension` directory.
Prefer `npm run test:package` for release checks: it verifies the exact VSIX,
unpacks it into a temporary directory, and loads that packaged extension rather
than rebuilding or testing the source checkout. It uses the current manifest's
VSIX filename unless `LINEBEAM_VSIX` names another file. Temporary profiles,
fixtures, and unpacked packages are removed after the run.

Before sharing the preview, test the final artifact on the declared minimum and
current stable VS Code. In a shell without `VSCODE_EXECUTABLE_PATH` set:

```powershell
npm run check
npm run package
$env:VSCODE_TEST_VERSION = "1.96.0"
npm run test:package
$env:VSCODE_TEST_VERSION = "stable"
npm run test:package
Remove-Item Env:\VSCODE_TEST_VERSION
```

The test runner downloads and caches official VS Code test builds when needed.
Set either `VSCODE_TEST_VERSION` or `VSCODE_EXECUTABLE_PATH`, not both; conflicting
selectors fail rather than silently testing the wrong host. CI packages on
Windows and Linux, and tests that same Linux package on both VS Code versions
before uploading it. `npm run verify:package` can recheck an existing artifact
without launching VS Code. These checks are local and do not publish anything.

Live account consent, provider billing/quotas, and model explanation quality
need a manual check with your own Copilot access; automated tests use
deterministic adapters and do not incur model usage.

| Location | Responsibility |
| --- | --- |
| `src/core` | Immutable contracts, hunk construction, prompt budgeting, strict validation, coverage |
| `src/git` | Read-only Git subprocesses, path boundaries, capture, freshness |
| `src/model` | Single-request generation and the VS Code Copilot adapter |
| `src/ui` | Native diffs, virtual documents, decorations, sidebar state/message boundary |
| `src/fixtures` | Offline walkthrough with additions, deletions, renames, and omissions |
| `media` | Theme-aware, keyboard-accessible sidebar; no external resources |
| `test` | Core, Git, model, webview, and extension-host regression coverage |

See [the design notes](https://github.com/lukiiiz22/linebeam/blob/main/docs/design.md)
for the handoff review, invariants, and
future integration boundary.

## Not in this release

Task attribution, `publish_review` language-model tools, lifecycle hooks, MCP
bridges, hosted PR fetching, web VS Code, remote workspaces, multi-root/multi-repo
review, custom provider billing, and autonomous fixes are deferred. Future
agent integrations should publish to the same snapshot/plan engine, not build
provider-specific review engines.

## License

[MIT](https://github.com/lukiiiz22/linebeam/blob/main/LICENSE).
