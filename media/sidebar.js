'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state;
  let reviewKey = '';
  let snapshotDetailsOpen = false;
  const expandedFiles = new Set();
  const filterLabels = {
    all: 'All changes',
    unexplained: 'Unexplained hunks',
    unsupported: 'Unsupported files',
    skipped: 'Skipped hunks',
    metadata: 'Metadata changes',
  };

  function quantity(number, singular, plural = `${singular}s`) {
    return `${number} ${number === 1 ? singular : plural}`;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(text, message, className = 'button secondary', disabled = false) {
    const element = node('button', className, text);
    element.type = 'button';
    element.dataset.key = `${className.split(' ')[0]}:${JSON.stringify(message)}`;
    element.dataset.baseDisabled = String(disabled);
    element.disabled = disabled || Boolean(state?.busy);
    element.addEventListener('click', () => vscode.postMessage(message));
    return element;
  }

  function action(text, name, className, disabled = false) {
    return button(text, { type: 'action', action: name }, className, disabled);
  }

  function label(text) {
    return node('div', 'eyebrow', text);
  }

  function coverageButton(text, review, filter, className) {
    const element = button(text, { type: 'coverage', snapshotId: review.snapshotId, filter }, className);
    element.setAttribute('aria-pressed', String(state.screen === 'changes' && state.coverageFilter === filter));
    element.title = `Show ${filterLabels[filter].toLowerCase()} from this snapshot`;
    element.addEventListener('click', () => {
      if (!state.busy && state.review?.snapshotId === review.snapshotId && state.screen === 'changes' && state.coverageFilter === filter) {
        revealCoverageResults();
        if (document.hasFocus?.()) focusCoverageControl();
      }
    });
    return element;
  }

  const header = node('header', 'brand');
  const mark = node('div', 'brand-mark', '\u2726');
  mark.setAttribute('aria-hidden', 'true');
  const brandText = node('div');
  brandText.append(node('div', 'brand-name', 'Linebeam'), node('div', 'brand-tagline', 'Key changes. Clear explanations.'));
  header.append(mark, brandText);

  const controls = node('details', 'controls');
  controls.open = true;
  const controlsSummary = node('summary', 'disclosure-summary');
  controlsSummary.dataset.key = 'capture-settings';
  const captureScope = node('span', 'capture-scope');
  controlsSummary.append(label('Next capture'), captureScope);
  const controlsBody = node('div', 'controls-body');
  const scope = action('', 'scope', 'setting-button');
  const model = action('', 'model', 'setting-button model-button');
  scope.setAttribute('aria-label', 'Choose Git change scope');
  model.setAttribute('aria-label', 'Choose Copilot model');
  const explain = action('\u2726  Explain Changes', 'explain', 'button primary explain');
  controlsBody.append(scope, model, explain);
  const privacy = node('p', 'microcopy', 'Sends captured text hunks to Copilot in one new request. Your Copilot usage and limits apply.');
  controlsBody.append(privacy);
  controls.append(controlsSummary, controlsBody);

  const scrollArea = node('div', 'sidebar-scroll');
  scrollArea.setAttribute('role', 'region');
  scrollArea.setAttribute('aria-label', 'Walkthrough content');
  scrollArea.tabIndex = 0;
  scrollArea.scrollTop = 0;
  const feedback = node('section', 'feedback');
  feedback.setAttribute('aria-label', 'Walkthrough status');
  const content = node('section', 'content');
  const footer = node('footer', 'footer');
  footer.append(node('p', '', 'Read-only snapshots. No edits, commits, or approvals.'));
  const footerActions = node('div', 'footer-actions');
  footerActions.append(action('Try offline demo', 'demo', 'text-button'), action('Clear walkthrough', 'clear', 'text-button'));
  footer.append(footerActions);
  scrollArea.append(header, controls, feedback, content, footer);
  const navigation = node('nav', 'step-navigation');
  navigation.setAttribute('aria-label', 'Walkthrough navigation');
  navigation.hidden = true;
  const previous = action('\u2190 Previous', 'previous', 'button secondary');
  const stepCounter = node('span', 'step-counter');
  stepCounter.setAttribute('role', 'status');
  const next = action('Next \u2192', 'next', 'button primary');
  navigation.append(previous, stepCounter, next);
  app.append(scrollArea, navigation);

  function revealInPanel(target, inset = 12) {
    const distance = target.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top;
    // scrollIntoView also scrolls ancestor frames, including VS Code's webview host.
    scrollArea.scrollTop = Math.max(0, scrollArea.scrollTop + distance - inset);
  }

  function revealCoverageResults() {
    const controls = content.querySelector('.coverage-controls');
    revealInPanel(content.querySelector('.coverage-results'), controls.getBoundingClientRect().height + 12);
  }

  function focusCoverageControl() {
    const target = content.querySelector('.coverage-controls .filter-button[aria-pressed="true"]');
    if (target && !target.disabled) target.focus({ preventScroll: true });
  }

  function banner(title, detail, className, role) {
    const box = node('div', `banner ${className}`);
    if (role) box.setAttribute('role', role);
    box.append(node('strong', '', title), node('p', '', detail));
    return box;
  }

  function renderFeedback(current) {
    feedback.replaceChildren();
    if (current.busy) {
      const progress = node('div', 'progress-banner');
      const spinner = node('span', 'spinner');
      spinner.setAttribute('aria-hidden', 'true');
      const message = node('span', '', current.progress || 'Preparing walkthrough...');
      message.setAttribute('role', 'status');
      const cancel = action('Cancel', 'cancel', 'text-button');
      cancel.dataset.allowBusy = 'true';
      cancel.disabled = false;
      progress.append(spinner, message, cancel);
      feedback.append(progress);
    }
    if (current.error) {
      feedback.append(banner('Walkthrough not generated', current.error, 'error-banner', 'alert'));
    }
    if (current.staleReason) {
      const stale = banner('Viewing an older snapshot', current.staleReason, 'stale-banner', 'status');
      stale.append(action('Regenerate from current changes', 'explain', 'text-button'));
      feedback.append(stale);
    }
    if (current.notice) {
      feedback.append(banner('Linebeam', current.notice, 'notice-banner', 'status'));
    }
    if (current.unsavedCount > 0) {
      feedback.append(node('p', 'unsaved-note', `${current.unsavedCount} unsaved file${current.unsavedCount === 1 ? '' : 's'} in this workspace. Unsaved buffers are never included.`));
    }
  }

  function renderEmpty() {
    const empty = node('section', 'empty-state');
    empty.append(label('A reading path through your diff'));
    empty.append(node('h1', '', 'Understand the change.\nNot just the diff.'));
    empty.append(node('p', 'intro', 'Turn a stack of agent-written changes into a short, evidence-linked walkthrough.'));
    const sequence = node('ol', 'how-it-works');
    for (const [title, detail] of [
      ['Capture a clear scope', 'Choose all local, staged, or unstaged changes.'],
      ['Follow the key changes', 'Read short notes beside native before/after diffs.'],
      ['See what remains', 'Skipped and unsupported changes stay visible.'],
    ]) {
      const item = node('li');
      item.append(node('strong', '', title), node('p', '', detail));
      sequence.append(item);
    }
    empty.append(sequence);
    const demo = action('Explore the offline demo \u2192', 'demo', 'button secondary demo-button');
    empty.append(demo, node('p', 'microcopy', 'No repository, sign-in, or model request needed for the demo.'));
    return empty;
  }

  function renderSummary(review) {
    const summary = node('section', 'snapshot-summary');
    const top = node('div', 'snapshot-top');
    top.append(node('span', 'repository-name', review.repository));
    top.append(node('span', `badge ${review.isDemo ? 'demo-badge' : ''}`, review.isDemo ? 'OFFLINE DEMO' : 'SNAPSHOT'));
    summary.append(top);
    const timestamp = new Date(review.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const meta = node('p', 'snapshot-meta', `Captured: ${review.scopeLabel} \u00b7 ${timestamp} \u00b7 ${quantity(review.files.length, 'file')}`);
    meta.title = `${review.scopeDescription}\nBase: ${review.baseLabel}\nSnapshot: ${review.snapshotId}`;
    summary.append(meta);
    const count = node('div', 'coverage-count');
    count.append(node('strong', '', `${review.summary.explained}`), node('span', '', ` / ${quantity(review.summary.totalHunks, 'text hunk')} explained`));
    summary.append(count);
    const progress = node('progress', 'coverage-meter');
    progress.max = review.summary.totalHunks || 1;
    progress.value = review.summary.explained;
    progress.setAttribute('aria-label', `${review.summary.explained} of ${quantity(review.summary.totalHunks, 'text hunk')} explained`);
    summary.append(progress);
    const remainder = node('div', 'coverage-remainder');
    for (const [number, name, filter] of [
      [review.summary.unexplained, 'unexplained hunk', 'unexplained'],
      [review.summary.unsupported, 'unsupported file', 'unsupported'],
      [review.summary.skipped, 'skipped hunk', 'skipped'],
      [review.summary.metadata, 'metadata change', 'metadata'],
    ]) {
      if (number > 0) remainder.append(coverageButton(quantity(number, name), review, filter, 'coverage-pill'));
    }
    if (remainder.childElementCount > 0) summary.append(remainder);
    summary.append(node('p', 'verification-note', 'Explained is not verified. Tests have not been run.'));
    const details = node('details', 'snapshot-details');
    details.open = snapshotDetailsOpen;
    details.addEventListener('toggle', () => {
      if (details.isConnected && state.review?.snapshotId === review.snapshotId) snapshotDetailsOpen = details.open;
    });
    const detailsSummary = node('summary', 'disclosure-summary', 'Snapshot details');
    detailsSummary.dataset.key = 'snapshot-details';
    const values = node('dl', 'snapshot-values');
    for (const [name, value] of [
      ['Model', review.modelName],
      ['Comparison', review.scopeDescription],
      ['Baseline', review.baseLabel],
      ['Captured', new Date(review.capturedAt).toLocaleString()],
      ['Snapshot', review.snapshotId],
    ]) {
      values.append(node('dt', '', name), node('dd', '', value));
    }
    details.append(detailsSummary, values, node('p', 'microcopy', 'An explanation is not verification. Referenced tests have not been run by Linebeam.'));
    if (state.captureNote) details.append(node('p', 'microcopy', state.captureNote));
    summary.append(details);
    return summary;
  }

  function renderWalkthrough(review) {
    const container = node('section', 'walkthrough');
    const step = review.steps[state.selectedStep];
    if (!step) {
      const message = review.files.length === 0
        ? 'No saved changes in this scope. Try another scope or make a change first.'
        : 'No explanation steps are available. All Changes shows the captured files and every omission.';
      container.append(banner('Nothing to walk through yet', message, 'notice-banner'));
      container.append(action('Show All Changes', 'all', 'button secondary'));
      return container;
    }
    const card = node('article', 'step-card');
    const stepHeader = node('div', 'step-header');
    stepHeader.append(label(`Step ${state.selectedStep + 1} of ${review.steps.length}`), node('span', 'read-only-label', 'READ-ONLY'));
    card.append(stepHeader, node('h2', '', step.title), node('p', 'explanation', step.explanation));
    const significance = node('div', 'significance');
    significance.append(label('Why it matters'), node('p', '', step.significance));
    card.append(significance);
    if (step.question) {
      const question = node('div', 'review-question');
      question.append(label('A question to carry forward'), node('p', '', step.question));
      card.append(question);
    }
    const evidence = node('section', 'evidence');
    evidence.append(label('Follow the evidence'));
    for (const reference of step.references) {
      const item = button('', {
        type: 'reference',
        snapshotId: review.snapshotId,
        stepId: step.id,
        index: reference.index,
      }, 'reference-button');
      const side = node('span', `side-badge ${reference.side}`, reference.side === 'old' ? 'BEFORE' : 'AFTER');
      item.append(side, node('span', 'reference-path', reference.path), node('span', 'reference-lines', `L${reference.lines}`));
      item.title = `Open captured ${reference.side === 'old' ? 'before' : 'after'} evidence: ${reference.path}, lines ${reference.lines}`;
      evidence.append(item);
    }
    card.append(evidence);
    container.append(card);
    const order = node('section', 'reading-order');
    order.append(label('Reading order'));
    for (const [index, entry] of review.steps.entries()) {
      const item = button('', { type: 'step', snapshotId: review.snapshotId, index }, `order-button ${index === state.selectedStep ? 'current' : ''}`);
      if (index === state.selectedStep) item.setAttribute('aria-current', 'step');
      item.append(node('span', 'step-number', String(index + 1).padStart(2, '0')), node('span', '', entry.title));
      order.append(item);
    }
    container.append(order);
    return container;
  }

  function renderChanges(review) {
    const container = node('section', 'all-changes');
    const heading = node('div', 'changes-heading');
    heading.append(node('h2', '', 'Every change, accounted for'), node('p', 'microcopy', 'Hunks link to captured code. File-level entries explain metadata or content that was not analyzed.'));
    container.append(heading);
    const filters = node('div', 'coverage-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Coverage filters');
    for (const [filter, name] of Object.entries(filterLabels)) {
      filters.append(coverageButton(name, review, filter, 'filter-button'));
    }
    const coverageControls = node('div', 'coverage-controls');
    coverageControls.append(filters);
    const visibleFiles = review.files.filter((file) =>
      state.coverageFilter === 'all' || file.entries.some((entry) => entry.matchesFilter),
    );
    const resultCount = node('p', 'filter-result', `${filterLabels[state.coverageFilter]} \u00b7 Showing ${visibleFiles.length} of ${quantity(review.files.length, 'captured file')}`);
    resultCount.setAttribute('role', 'status');
    coverageControls.append(resultCount);
    const results = node('div', 'coverage-results');
    container.append(coverageControls, results);
    if (review.files.length === 0) {
      results.append(node('p', 'intro', 'No saved changes in this scope.'));
    } else if (visibleFiles.length === 0) {
      results.append(
        node('p', 'intro', `No ${filterLabels[state.coverageFilter].toLowerCase()} in this snapshot.`),
        coverageButton('Show all captured changes', review, 'all', 'button secondary reset-filter'),
      );
    }
    const filter = state.coverageFilter;
    for (const file of visibleFiles) {
      const item = node('details', 'file-card');
      item.open = filter !== 'all' || expandedFiles.has(`${review.snapshotId}:${file.id}`);
      item.addEventListener('toggle', () => {
        if (!item.isConnected || filter !== 'all' || state.coverageFilter !== 'all' || state.review?.snapshotId !== review.snapshotId) return;
        const key = `${review.snapshotId}:${file.id}`;
        if (item.open) expandedFiles.add(key);
        else expandedFiles.delete(key);
      });
      const heading = node('summary', 'file-summary');
      const fileName = node('span', 'file-path', file.path);
      fileName.title = file.path;
      const needsAttention = file.entries.some((entry) => entry.status !== 'explained');
      heading.append(node('span', `file-dot ${needsAttention ? 'uncovered' : 'covered'}`), fileName, node('span', 'file-kind', file.kind));
      item.append(heading);
      const body = node('div', 'file-body');
      if (file.oldPath !== file.path) body.append(node('p', 'renamed-from', `From ${file.oldPath}`));
      const open = button(file.canOpen ? 'Open captured diff \u2197' : 'No text preview available', {
        type: 'file', snapshotId: review.snapshotId, fileId: file.id,
      }, 'text-button open-file', !file.canOpen);
      body.append(open);
      for (const entry of file.entries.filter((entry) => entry.matchesFilter)) {
        const row = node('div', 'coverage-entry');
        const top = node('div', 'coverage-entry-top');
        const statusLabel = entry.status === 'unexplained' ? 'NOT EXPLAINED' : entry.status.toUpperCase();
        top.append(node('span', `coverage-status ${entry.status}`, statusLabel));
        if (entry.steps.length > 0) top.append(node('span', 'microcopy', `Step${entry.steps.length > 1 ? 's' : ''} ${entry.steps.join(', ')}`));
        row.append(top);
        if (entry.hunkId) {
          row.append(button(entry.label, {
            type: 'file', snapshotId: review.snapshotId, fileId: file.id, hunkId: entry.hunkId,
          }, 'hunk-button'));
        } else {
          row.append(node('span', 'file-level-label', entry.label));
        }
        row.append(node('p', '', entry.reason));
        body.append(row);
      }
      item.append(body);
      results.append(item);
    }
    return container;
  }

  function renderReview(current) {
    const review = current.review;
    if (!review) return renderEmpty();
    const container = node('div');
    container.append(renderSummary(review));
    const tabs = node('nav', 'tabs');
    tabs.setAttribute('aria-label', 'Walkthrough views');
    const walkthrough = action('Walkthrough', 'walkthrough', `tab ${current.screen === 'walkthrough' ? 'selected' : ''}`);
    const changes = action(`All Changes (${review.files.length})`, 'all', `tab ${current.screen === 'changes' ? 'selected' : ''}`);
    walkthrough.setAttribute('aria-pressed', String(current.screen === 'walkthrough'));
    changes.setAttribute('aria-pressed', String(current.screen === 'changes'));
    tabs.append(walkthrough, changes);
    container.append(tabs, current.screen === 'changes' ? renderChanges(review) : renderWalkthrough(review));
    return container;
  }

  function render(current) {
    const oldState = state;
    state = current;
    const hadPanelFocus = Boolean(document.hasFocus?.());
    const activeKey = hadPanelFocus ? document.activeElement?.dataset?.key : undefined;
    const snapshotChanged = oldState?.review?.snapshotId !== current.review?.snapshotId;
    if (snapshotChanged) {
      controls.open = !current.review;
      snapshotDetailsOpen = false;
      expandedFiles.clear();
    }
    app.classList.toggle('has-review', Boolean(current.review));
    captureScope.textContent = current.scopeLabel;
    controlsSummary.title = `Next capture: ${current.scopeDescription}. Model: ${current.preferredModelName}.`;
    scope.textContent = `${current.scopeLabel} \u2304`;
    scope.title = `${current.scopeDescription}. Click to choose the next capture scope.`;
    model.textContent = `${current.preferredModelName} \u2304`;
    model.title = 'Choose an available Copilot model. No API key or separate backend.';
    explain.textContent = current.busy ? 'Creating walkthrough...' : current.review ? '\u2726  Explain Changes Again' : '\u2726  Explain Changes';
    renderFeedback(current);
    const currentStep = current.review?.steps[current.selectedStep];
    navigation.hidden = current.screen !== 'walkthrough' || !currentStep;
    const counterText = currentStep ? `${current.selectedStep + 1} / ${current.review.steps.length}` : '';
    if (stepCounter.textContent !== counterText) stepCounter.textContent = counterText;
    stepCounter.setAttribute('aria-label', currentStep ? `Step ${current.selectedStep + 1} of ${current.review.steps.length}` : 'No steps');
    previous.dataset.baseDisabled = String(!current.canGoPrevious);
    next.dataset.baseDisabled = String(!current.canGoNext);
    let focusCoverage = false;
    const key = JSON.stringify([current.review, current.screen, current.selectedStep, current.captureNote, current.coverageFilter]);
    if (key !== reviewKey) {
      reviewKey = key;
      const scrollPosition = scrollArea.scrollTop;
      content.replaceChildren(renderReview(current));
      const readingStep = current.screen === 'walkthrough' && Boolean(current.review?.steps[current.selectedStep]);
      const changedView = oldState && (oldState.screen !== current.screen || oldState.coverageFilter !== current.coverageFilter);
      const changedStep = oldState && oldState.selectedStep !== current.selectedStep;
      if (current.review && current.screen === 'changes' && (snapshotChanged || changedView)) {
        revealCoverageResults();
        focusCoverage = hadPanelFocus && Boolean(changedView);
      } else if (!snapshotChanged && readingStep && (changedView || changedStep)) {
        revealInPanel(content.querySelector('.step-card'));
      } else {
        scrollArea.scrollTop = snapshotChanged || changedView ? 0 : scrollPosition;
      }
    }
    for (const element of app.querySelectorAll('button')) {
      element.disabled = element.dataset.baseDisabled === 'true' || (current.busy && element.dataset.allowBusy !== 'true');
    }
    if (focusCoverage && !current.busy) {
      focusCoverageControl();
    } else if (activeKey) {
      const target = [...app.querySelectorAll('[data-key]')].find((element) => element.dataset.key === activeKey);
      if (target && !target.disabled && document.activeElement !== target) target.focus({ preventScroll: true });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'state') render(event.data);
  });
  vscode.postMessage({ type: 'ready' });
})();
