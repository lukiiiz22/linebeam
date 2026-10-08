# Changelog

## 0.1.2 - 2026-09-20

- Rename the private preview from DiffQuill to Linebeam, including its public
  extension identity, commands, settings, branding, and release tooling.
- Require explicit migration of old scope/privacy settings before capture;
  keep the immutable snapshot document protocol stable.
- Include generated license and NOTICE texts for all bundled runtime
  dependencies, and reject packages with missing or stale release contents.
- Add exact-VSIX smoke checks and CI coverage for the minimum supported and
  current stable VS Code versions, without calling a real model.
- Reveal coverage results when a filter is selected or re-selected, keeping
  filter controls and result counts visible while scrolling.
- Confine navigation scrolling to the sidebar viewport and keep keyboard
  focus on the visible selected filter instead of an offscreen badge.
- Give Snapshot details a stronger bordered header and replace disclosure
  plus/minus markers with native-summary-compatible chevrons.

## 0.1.1 - 2026-09-20

- Keep the step counter and navigation visible in a non-scrolling sidebar
  footer; collapse capture settings and detailed snapshot provenance while
  reading.
- Make coverage badges open snapshot-bound filters with expanded omission
  reasons, visible result counts, empty states, and an all-changes reset.
- Align native toolbar navigation with sidebar boundary/busy states and fix
  singular/plural file, hunk, and metadata labels.
- Ignore superseded view-opening requests so a late completion cannot override
  a newer coverage filter or report an invalid reference after Clear.

## 0.1.0 - 2026-09-18

- Initial local desktop MVP: explicit Git scopes, immutable snapshots, native
  diffs, changed-line highlights, a guided explanation sidebar, and navigation.
- Runtime Copilot model selection, bounded single-request generation, strict
  hunk-reference validation, cancellation, and explicit failure states.
- Visible coverage, exclusions, unsupported content, metadata changes, and
  stale-snapshot warnings.
- Offline demo, development/packaging scripts, regression tests, and CI.
