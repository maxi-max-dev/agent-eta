import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class FakeElement {
  constructor(selector) {
    this.selector = selector;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.dateTime = '';
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      values: new Set(),
      toggle: (name, force) => {
        if (force) this.classList.values.add(name);
        else this.classList.values.delete(name);
      },
    };
    this.style = {
      values: new Map(),
      setProperty: (name, value) => this.style.values.set(name, value),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name, event = {}) {
    const listeners = this.listeners.get(name) ?? [];
    return listeners.map((listener) => listener({ preventDefault() {}, ...event })).at(-1);
  }

  replaceChildren(...children) {
    this.children = children;
    if (!this.value && children[0]?.value) this.value = children[0].value;
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.onmessage = null;
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }

  dispatch(name, data = '') {
    const event = { data };
    if (name === 'message') this.onmessage?.(event);
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  close() {
    this.closed = true;
  }
}

function projection(headline, revision = 1) {
  return {
    available: true,
    selectionId: 'sel-0123456789abcdefabcd',
    scope: 'run',
    status: 'working',
    projectionRevision: revision,
    cursor: 1,
    eventCount: 2,
    display: {
      headline,
      remaining: '还剩约 10 分钟',
      range: '大致 12:10–12:20',
      currentStep: '正在步骤 1',
      reason: '真实事件已到达',
      tone: 'working',
      status: 'working',
      statusLabel: '工作中',
      confidence: 'prior_only',
      confidenceLabel: '证据：先验估计',
    },
    forecast: { p50Minutes: 10, p80Minutes: 15, lowerMinutes: 6 },
    capturedAt: '2026-08-29T02:00:00.000Z',
    capturedLabel: '采集于 08/29 12:00',
  };
}

function response(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function mountShadowUi() {
  FakeEventSource.instances.length = 0;
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new FakeElement(selector));
    return elements.get(selector);
  };
  let statusPayload = {
    kind: 'live_watch_status',
    enabled: false,
    running: false,
    status: 'disabled',
    lastScanAt: null,
    lastSuccessAt: null,
    lastChangeAt: '2026-08-29T01:00:00.000Z',
    errorCode: null,
    pollIntervalMs: 1_000,
  };
  let latestPayload = projection('STALE LIVE MUST NOT APPEAR');
  let activePayload = {
    kind: 'live_active',
    defaultSelectionId: 'sel-0123456789abcdefabcd',
    selections: [{
      selectionId: 'sel-0123456789abcdefabcd',
      status: 'working',
      observedAt: '2026-08-29T02:00:00.000Z',
      projectionRevision: 1,
      meta: {
        provider: 'codex',
        planObserved: false,
        evidenceConfidence: 'prior_only',
        scopeAvailability: { run: 'available', task: 'unknown', project: 'unknown' },
      },
    }],
  };
  const requests = [];
  const scheduled = new Map();
  let timerId = 0;

  const context = {
    console,
    Intl,
    Date,
    EventSource: FakeEventSource,
    document: {
      querySelector: element,
      createElement: (tag) => new FakeElement(tag),
    },
    window: { addEventListener() {} },
    fetch: async (url) => {
      requests.push(url);
      if (url === '/api/fixtures') return response([{ id: 'demo', title: '演示' }]);
      if (url === '/api/state') return response(projection('DEMO PROJECTION'));
      if (url === '/api/live/active') return response(activePayload);
      if (url.startsWith('/api/live/status')) return response(statusPayload);
      if (url.startsWith('/api/live/latest')) return response(latestPayload);
      throw new Error(`unexpected URL ${url}`);
    },
    setTimeout: (callback, delay) => {
      timerId += 1;
      scheduled.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => scheduled.delete(id),
    queueMicrotask,
  };
  vm.runInNewContext(readFileSync(join(ROOT, 'public/app.js'), 'utf8'), context, {
    filename: 'public/app.js',
  });

  return {
    element,
    requests,
    scheduled,
    setStatus(value) { statusPayload = value; },
    setLatest(value) { latestPayload = value; },
    setActive(value) { activePayload = value; },
  };
}

test('live source DOM stays a single arrival window with a quiet watcher status', () => {
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');
  assert.match(html, /id="live-mode"[\s\S]*实时任务/);
  assert.match(html, /id="live-controls"/);
  assert.match(html, /id="watcher-state"/);
  assert.match(html, /id="watcher-time"/);
  assert.match(html, /id="live-refresh"/);
  assert.match(html, /id="scope-run"[\s\S]*本轮/);
  assert.match(html, /id="scope-task"[\s\S]*任务/);
  assert.match(html, /id="scope-project"[\s\S]*项目/);
  assert.match(html, /id="active-select"/);
  assert.match(html, /id="eta-remaining"/);
  assert.match(html, /id="eta-confidence"/);
  assert.equal((html.match(/class="arrival"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /本机快照|静态记录，不是实时监听|进度百分比/);
  assert.match(css, /\.live-strip\s*\{[\s\S]*min-width:\s*0/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*\.watcher-meta/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('live mode clears Demo before I/O and fails closed for disabled, empty, and SSE refresh states', async () => {
  const ui = mountShadowUi();
  await flush();
  assert.equal(
    ui.element('#eta-headline').textContent,
    'DEMO PROJECTION',
    JSON.stringify({ requests: ui.requests, error: ui.element('#error-message').textContent }),
  );
  assert.equal(FakeEventSource.instances[0].url, '/api/stream');

  const switchPromise = ui.element('#live-mode').dispatch('click');
  assert.equal(ui.element('#eta-headline').textContent, '正在接入实时任务…');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /DEMO/);
  await switchPromise;
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '实时监听未启用');
  assert.equal(ui.element('#watcher-state span').textContent, '监听未启用');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /STALE LIVE|DEMO/);
  assert.ok(ui.requests.includes('/api/live/active'));
  assert.ok(ui.requests.some((url) => url.startsWith('/api/live/status?selection=')));
  assert.ok(ui.requests.some((url) => url.startsWith('/api/live/latest?selection=')));

  ui.setStatus({
    kind: 'live_watch_status',
    enabled: true,
    running: true,
    status: 'running',
    lastScanAt: '2026-08-29T02:01:00.000Z',
    lastSuccessAt: '2026-08-29T02:01:00.000Z',
    lastChangeAt: '2026-08-29T02:00:00.000Z',
    errorCode: null,
    pollIntervalMs: 1_000,
  });
  ui.setLatest({ available: false, capturedAt: null, capturedLabel: '尚未采集' });
  ui.element('#live-refresh').dispatch('click');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '正在等待真实任务');
  assert.equal(ui.element('#watcher-state span').textContent, '实时监听中');

  ui.setLatest(projection('预计 12:10 完成'));
  FakeEventSource.instances[0].dispatch('live', 'updated');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '预计 12:10 完成');
  assert.equal(ui.element('#watcher-time').textContent, '采集于 08/29 12:00');

  ui.setLatest(projection('预计 12:08 完成'));
  FakeEventSource.instances[0].dispatch('message', JSON.stringify({ kind: 'live_update' }));
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '预计 12:08 完成');
  assert.ok([...ui.scheduled.values()].every(({ delay }) => delay >= 5_000));
});

test('degraded and error watcher states never leave a previous live ETA visible', async () => {
  const ui = mountShadowUi();
  await flush();
  await ui.element('#live-mode').dispatch('click');
  await flush();

  ui.setStatus({
    kind: 'live_watch_status',
    enabled: true,
    running: true,
    status: 'degraded',
    lastScanAt: '2026-08-29T02:01:00.000Z',
    lastSuccessAt: '2026-08-29T02:00:00.000Z',
    lastChangeAt: '2026-08-29T02:01:00.000Z',
    errorCode: null,
    pollIntervalMs: 2_000,
  });
  ui.setLatest(projection('OLD LIVE ETA'));
  FakeEventSource.instances[0].dispatch('live');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '实时监听暂时降级');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /OLD LIVE ETA/);

  ui.setStatus({
    kind: 'live_watch_status',
    enabled: true,
    running: true,
    status: 'stale',
    lastScanAt: '2026-08-29T02:01:30.000Z',
    lastSuccessAt: '2026-08-29T02:01:30.000Z',
    lastChangeAt: '2026-08-29T02:01:30.000Z',
    errorCode: null,
    pollIntervalMs: 2_000,
  });
  FakeEventSource.instances[0].dispatch('live');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '正在等待新任务');
  assert.equal(ui.element('#watcher-state span').textContent, '等待新任务');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /OLD LIVE ETA|DEMO/);

  ui.setStatus({
    kind: 'live_watch_status',
    enabled: true,
    running: false,
    status: 'error',
    lastScanAt: '2026-08-29T02:02:00.000Z',
    lastSuccessAt: '2026-08-29T02:00:00.000Z',
    lastChangeAt: '2026-08-29T02:02:00.000Z',
    errorCode: 'scan_failed',
    pollIntervalMs: 2_000,
  });
  FakeEventSource.instances[0].dispatch('message', JSON.stringify({ kind: 'live_update' }));
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '实时监听暂不可用');
  assert.equal(ui.element('#watcher-state span').textContent, '监听异常');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /OLD LIVE ETA|DEMO/);
});

test('fixed selection survives unrelated activity and stale projection revisions are rejected', async () => {
  const ui = mountShadowUi();
  await flush();
  ui.setStatus({
    kind: 'live_watch_status',
    enabled: true,
    running: true,
    status: 'running',
    lastScanAt: '2026-08-29T02:01:00.000Z',
    lastSuccessAt: '2026-08-29T02:01:00.000Z',
    lastChangeAt: '2026-08-29T02:00:00.000Z',
    errorCode: null,
    pollIntervalMs: 1_000,
  });
  ui.setLatest(projection('预计 12:10 完成', 2));
  await ui.element('#live-mode').dispatch('click');
  await flush();

  ui.setLatest(projection('预计 12:07 完成', 7));
  await ui.element('#live-refresh').dispatch('click');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '预计 12:07 完成');
  assert.equal(ui.element('#eta-remaining').textContent, '还剩约 10 分钟');
  assert.equal(ui.element('#eta-confidence').textContent, '证据：先验估计');

  ui.setActive({
    kind: 'live_active',
    defaultSelectionId: 'sel-fedcba98765432100123',
    selections: [{
      selectionId: 'sel-fedcba98765432100123',
      status: 'working',
      observedAt: '2026-08-29T02:02:00.000Z',
      projectionRevision: 8,
      meta: { provider: 'codex', scopeAvailability: { run: 'available', task: 'unknown', project: 'unknown' } },
    }],
  });
  ui.setLatest(projection('OUT OF ORDER MUST NOT APPEAR', 3));
  FakeEventSource.instances[0].dispatch('live', 'updated');
  await flush();
  assert.equal(ui.element('#active-select').value, 'sel-0123456789abcdefabcd');
  assert.equal(ui.element('#eta-headline').textContent, '预计 12:07 完成');
  assert.ok(ui.requests.at(-1).includes('selection=sel-0123456789abcdefabcd'));
});

test('task scope uses the same arrival window and renders contract unknown without a number', async () => {
  const ui = mountShadowUi();
  await flush();
  ui.setStatus({
    kind: 'live_watch_status', enabled: true, running: true, status: 'running',
    lastScanAt: '2026-08-29T02:01:00.000Z', lastSuccessAt: '2026-08-29T02:01:00.000Z',
    lastChangeAt: null, errorCode: null, pollIntervalMs: 1_000,
  });
  await ui.element('#live-mode').dispatch('click');
  await flush();
  ui.setLatest({
    ...projection('任务 ETA 暂不可用', 9),
    available: false,
    scope: 'task',
    status: 'unknown',
    display: {
      headline: '任务 ETA 暂不可用',
      remaining: '没有显式工作集合',
      range: '当前不显示推测完成时间',
      currentStep: '—',
      reason: '宿主尚未提供唯一显式 task workset 与 owner terminal',
      tone: 'empty',
      status: 'unknown',
      statusLabel: '状态未知',
      confidence: 'unavailable',
      confidenceLabel: '证据：暂不可用',
    },
    forecast: { mode: 'unavailable', status: 'unavailable', p50Minutes: null, p80Minutes: null, lowerMinutes: null },
  });
  await ui.element('#scope-task').dispatch('click');
  await flush();
  assert.equal(ui.element('#eta-headline').textContent, '任务 ETA 暂不可用');
  assert.equal(ui.element('#eta-remaining').textContent, '没有显式工作集合');
  assert.doesNotMatch(ui.element('#eta-headline').textContent, /\d{2}:\d{2}/);
  assert.equal((readFileSync(join(ROOT, 'public/index.html'), 'utf8').match(/class="arrival"/g) ?? []).length, 1);
});

test('a workset-seeded selection opens the task scope and preserves its stopped clock', async () => {
  const ui = mountShadowUi();
  await flush();
  const selectionId = 'sel-11111111111111111111';
  ui.setStatus({
    kind: 'live_watch_status', enabled: true, running: true, status: 'running',
    lastScanAt: '2026-08-30T02:01:00.000Z', lastSuccessAt: '2026-08-30T02:01:00.000Z',
    lastChangeAt: null, errorCode: null, pollIntervalMs: 1_000,
  });
  ui.setLatest(projection('预计 12:10 完成', 2));
  await ui.element('#live-mode').dispatch('click');
  await flush();
  assert.equal(ui.element('#scope-run').classList.values.has('is-active'), true);

  ui.setActive({
    kind: 'live_active',
    defaultSelectionId: selectionId,
    selections: [{
      selectionId,
      status: 'blocked',
      observedAt: '2026-08-30T02:00:00.000Z',
      projectionRevision: 3,
      meta: {
        provider: 'codex',
        defaultScope: 'task',
        replacesSelectionId: 'sel-0123456789abcdefabcd',
        scopeAvailability: { run: 'available', task: 'available', project: 'unknown' },
      },
    }],
  });
  ui.setLatest({
    ...projection('暂时阻塞', 3),
    selectionId,
    scope: 'task',
    status: 'blocked',
    display: {
      headline: '暂时阻塞',
      remaining: '解除后还需约 6 分钟',
      range: '解除后约 3–8 分钟',
      currentStep: '任务工作集合已停止主动推进',
      reason: '等待时间不进入 ETA；只保留恢复后的 active 范围',
      tone: 'waiting',
      status: 'blocked',
      statusLabel: '暂时阻塞',
      confidence: 'prior_only',
      confidenceLabel: '证据：先验估计',
    },
    forecast: {
      mode: 'workset_blocked', status: 'blocked',
      p50Minutes: null, p80Minutes: null, lowerMinutes: null,
    },
  });
  FakeEventSource.instances[0].dispatch('live', 'updated');
  await flush();
  assert.equal(ui.element('#scope-task').classList.values.has('is-active'), true);
  assert.equal(ui.element('#active-select').value, selectionId);
  assert.equal(ui.element('#eta-headline').textContent, '暂时阻塞');
  assert.equal(ui.element('#eta-range').textContent, '解除后约 3–8 分钟');
  assert.doesNotMatch(
    `${ui.element('#eta-headline').textContent} ${ui.element('#eta-remaining').textContent}`,
    /\d{2}:\d{2}/,
  );
  assert.ok(ui.requests.some((url) => (
    url === `/api/live/status?selection=${selectionId}&scope=task`
  )));
  assert.ok(ui.requests.some((url) => (
    url === `/api/live/latest?selection=${selectionId}&scope=task`
  )));
  assert.equal((readFileSync(join(ROOT, 'public/index.html'), 'utf8').match(/class="arrival"/g) ?? []).length, 1);
});

test('verified status-only task stays visible and pinned quarantine clears prior completion claims', async () => {
  const ui = mountShadowUi();
  await flush();
  ui.setStatus({
    kind: 'live_watch_status', enabled: true, running: true, status: 'running',
    lastScanAt: '2026-08-30T02:01:00.000Z', lastSuccessAt: '2026-08-30T02:01:00.000Z',
    lastChangeAt: null, errorCode: null, pollIntervalMs: 1_000,
  });
  ui.setLatest(projection('RUN BEFORE GOAL', 2));
  await ui.element('#live-mode').dispatch('click');
  await flush();

  const runSelection = 'sel-0123456789abcdefabcd';
  const taskSelection = 'sel-44444444444444444444';
  ui.setActive({
    kind: 'live_active',
    defaultSelectionId: taskSelection,
    selections: [{
      selectionId: taskSelection,
      status: 'working',
      observedAt: '2026-08-30T02:02:00.000Z',
      projectionRevision: 4,
      meta: {
        provider: 'codex',
        defaultScope: 'task',
        replacesSelectionId: runSelection,
        scopeAvailability: { run: 'available', task: 'available', project: 'unknown' },
      },
    }],
  });
  ui.setLatest({
    ...projection('任务进行中', 4),
    selectionId: taskSelection,
    scope: 'task',
    status: 'working',
    display: {
      headline: '任务进行中',
      remaining: 'ETA 证据不足',
      range: '当前不显示推测完成时间',
      currentStep: '已识别跨 turn 的 Agent 任务',
      reason: '结构化 Goal 已确认任务仍在进行；当前证据不足以给出可靠 ETA',
      tone: 'working',
      status: 'working',
      statusLabel: '工作中',
      confidence: 'unavailable',
      confidenceLabel: '证据：暂不可用',
    },
    forecast: {
      mode: 'workset_unknown', status: 'unknown',
      p50Minutes: null, p80Minutes: null, lowerMinutes: null,
    },
  });
  FakeEventSource.instances[0].dispatch('live', 'updated');
  await flush();
  assert.equal(ui.element('#active-select').value, taskSelection);
  assert.equal(ui.element('#scope-task').classList.values.has('is-active'), true);
  assert.equal(ui.element('#eta-headline').textContent, '任务进行中');
  assert.equal(ui.element('#eta-remaining').textContent, 'ETA 证据不足');

  ui.setActive({
    kind: 'live_active',
    defaultSelectionId: runSelection,
    selections: [{
      selectionId: runSelection,
      status: 'working',
      observedAt: '2026-08-30T02:03:00.000Z',
      projectionRevision: 5,
      meta: {
        provider: 'codex', defaultScope: 'run',
        scopeAvailability: { run: 'available', task: 'unknown', project: 'unknown' },
      },
    }],
  });
  ui.setLatest({
    ...projection('结构证据冲突，ETA 不可用', 4),
    available: false,
    selectionId: taskSelection,
    scope: 'task',
    status: 'unknown',
    capturedAt: '2026-08-30T02:03:00.000Z',
    display: {
      headline: '结构证据冲突，ETA 不可用',
      remaining: '此前 ETA 与完成断言已停用',
      range: '当前不显示推测完成时间',
      currentStep: '任务身份待重新确认',
      reason: '结构事件发生冲突；已停止使用此前 ETA 与完成断言',
      tone: 'empty',
      status: 'unknown',
      statusLabel: '状态未知',
      confidence: 'unavailable',
      confidenceLabel: '证据：暂不可用',
      comparison: null,
    },
    forecast: {
      mode: 'unavailable', status: 'quarantined',
      p50Minutes: null, p80Minutes: null, lowerMinutes: null,
    },
  });
  FakeEventSource.instances[0].dispatch('live', 'updated');
  await flush();
  assert.equal(ui.element('#active-select').value, taskSelection);
  assert.equal(ui.element('#scope-task').classList.values.has('is-active'), true);
  assert.equal(ui.element('#eta-headline').textContent, '结构证据冲突，ETA 不可用');
  assert.equal(ui.element('#eta-status').textContent, '状态未知');
  assert.doesNotMatch(
    `${ui.element('#eta-headline').textContent} ${ui.element('#eta-remaining').textContent} ${ui.element('#eta-range').textContent}`,
    /已完成|实际用时|预计 \d{2}:\d{2}/,
  );
  assert.ok(ui.requests.some((url) => (
    url === `/api/live/status?selection=${taskSelection}&scope=task`
  )));
});

test('conflicting task replacements never migrate the selected run, regardless of ordering', async () => {
  const ui = mountShadowUi();
  await flush();
  ui.setStatus({
    kind: 'live_watch_status', enabled: true, running: true, status: 'running',
    lastScanAt: '2026-08-30T02:01:00.000Z', lastSuccessAt: '2026-08-30T02:01:00.000Z',
    lastChangeAt: null, errorCode: null, pollIntervalMs: 1_000,
  });
  ui.setLatest(projection('RUN REMAINS SELECTED', 2));
  await ui.element('#live-mode').dispatch('click');
  await flush();

  const runSelection = 'sel-0123456789abcdefabcd';
  const taskSelections = ['sel-22222222222222222222', 'sel-33333333333333333333'];
  const ambiguousPayload = (ordered) => ({
    kind: 'live_active',
    defaultSelectionId: ordered[0],
    selections: ordered.map((selectionId) => ({
      selectionId,
      status: 'blocked',
      observedAt: '2026-08-30T02:02:00.000Z',
      projectionRevision: 3,
      meta: {
        provider: 'codex',
        defaultScope: 'task',
        replacesSelectionId: runSelection,
        scopeAvailability: { run: 'available', task: 'available', project: 'unknown' },
      },
    })),
  });

  for (const ordered of [taskSelections, [...taskSelections].reverse()]) {
    ui.setActive(ambiguousPayload(ordered));
    ui.setLatest(projection('RUN REMAINS SELECTED', 3));
    FakeEventSource.instances[0].dispatch('live', 'updated');
    await flush();
    assert.equal(ui.element('#active-select').value, runSelection);
    assert.equal(ui.element('#scope-run').classList.values.has('is-active'), true);
    assert.equal(ui.element('#eta-headline').textContent, 'RUN REMAINS SELECTED');
    assert.ok(ui.requests.at(-1).includes(`selection=${runSelection}`));
    assert.ok(ui.requests.at(-1).includes('scope=run'));
  }
});
