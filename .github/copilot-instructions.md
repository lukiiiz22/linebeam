# Linebeam

Linebeam helps people understand changes; it does not edit code, run reviewed
code, approve changes, or claim that referenced tests passed.

- Keep Git capture, model planning/validation, and VS Code presentation separate.
- Both diff sides must use immutable `diffquill:` documents, never live file URIs.
  This internal snapshot protocol stays stable under the Linebeam product name.
- Models cite snapshot-bound hunk IDs and sides. Derive ranges from captured
  hunks; never accept model-provided paths, commands, or line numbers.
- Every file or hunk must remain visible as explained, skipped, unexplained, or
  unsupported. Never silently truncate the change set.
- Do not introduce automatic model retries or model calls during navigation.
- Render model text with `textContent` or untrusted `MarkdownString.appendText`.
  Keep the webview CSP and message allowlist intact.
- Git access is read-only, bounded, cancellable, and scoped to one local
  repository root. Do not follow symlinks or use a command shell.
- Use strict TypeScript and the existing Node test runner. `npm run check`
  covers types, unit tests, actual temporary Git repositories, sidebar behavior,
  and bundling. `npm run test:integration` exercises an isolated VS Code host
  without sending code to a real model.
- Update README and design documentation when changing scopes, limits, privacy,
  or coverage semantics. Do not reserve or publish a marketplace identity
  without the project owner's instruction.
