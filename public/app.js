const elements = {
  arrival: document.querySelector("#arrival"),
  headline: document.querySelector("#eta-headline"),
  remaining: document.querySelector("#eta-remaining"),
  etaStatus: document.querySelector("#eta-status"),
  confidence: document.querySelector("#eta-confidence"),
  range: document.querySelector("#eta-range"),
  currentStep: document.querySelector("#current-step"),
  reason: document.querySelector("#change-reason"),
  track: document.querySelector("#arrival-track"),
  eyebrow: document.querySelector("#arrival-eyebrow"),
  demoMode: document.querySelector("#demo-mode"),
  liveMode: document.querySelector("#live-mode"),
  scopeRun: document.querySelector("#scope-run"),
  scopeTask: document.querySelector("#scope-task"),
  scopeProject: document.querySelector("#scope-project"),
  activeField: document.querySelector("#active-field"),
  activeSelect: document.querySelector("#active-select"),
  fixtureSelect: document.querySelector("#fixture-select"),
  controls: document.querySelector("#replay-controls"),
  liveControls: document.querySelector("#live-controls"),
  watcherState: document.querySelector("#watcher-state"),
  watcherStateText: document.querySelector("#watcher-state span"),
  watcherTime: document.querySelector("#watcher-time"),
  watcherDetail: document.querySelector("#watcher-detail"),
  liveRefresh: document.querySelector("#live-refresh"),
  resetButton: document.querySelector("#reset-button"),
  nextButton: document.querySelector("#next-button"),
  nextLabel: document.querySelector("#next-label"),
  error: document.querySelector("#error-message"),
};

const LIVE_FALLBACK_MIN_MS = 5_000;
const LIVE_FALLBACK_MAX_MS = 30_000;

let latestProjection = null;
let watcherStatus = null;
let eventSource = null;
let fallbackTimer = null;
let requestPending = false;
let liveRefreshPending = false;
let liveRefreshQueued = false;
let activeMode = "demo";
let modeRevision = 0;
let liveQueryRevision = 0;
let activeScope = "run";
let selectedSelectionId = null;
const renderedRevisions = new Map();
const preferredScopes = new Map();

const scopeButtons = {
  run: elements.scopeRun,
  task: elements.scopeTask,
  project: elements.scopeProject,
};

async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload.error || payload.message || "";
    } catch {
      // The status text below remains useful when an endpoint returns no JSON.
    }
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }

  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("服务器返回了无法识别的数据");
  }
}

function showError(message) {
  elements.error.hidden = !message;
  elements.error.textContent = message ? `无法更新：${message}` : "";
}

function updateControlState() {
  const busy = requestPending || liveRefreshPending;
  elements.fixtureSelect.disabled = busy || activeMode !== "demo";
  elements.resetButton.disabled = busy || activeMode !== "demo" || !elements.fixtureSelect.value;
  elements.nextButton.disabled = busy
    || activeMode !== "demo"
    || !latestProjection
    || latestProjection.cursor >= latestProjection.eventCount;
  elements.liveRefresh.disabled = busy || activeMode !== "live";
  elements.activeSelect.disabled = busy || activeMode !== "live";
  for (const button of Object.values(scopeButtons)) button.disabled = busy || activeMode !== "live";
  elements.arrival.setAttribute("aria-busy", String(busy));
}

function setPending(pending) {
  requestPending = pending;
  updateControlState();
}

function setLiveRefreshPending(pending) {
  liveRefreshPending = pending;
  updateControlState();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function updateTrack(forecast, rangeText) {
  const lower = numberOrNull(forecast?.lowerMinutes);
  const median = numberOrNull(forecast?.p50Minutes);
  const upper = numberOrNull(forecast?.p80Minutes);

  if (lower === null || median === null || upper === null || upper <= 0) {
    elements.track.style.setProperty("--window-start", "0%");
    elements.track.style.setProperty("--window-width", "100%");
    elements.track.style.setProperty("--eta-position", "50%");
    elements.track.setAttribute("aria-label", rangeText || "到达窗口暂不可用");
    return;
  }

  // This is an arrival window, never a task-completion percentage.
  const horizon = Math.max(upper * 1.12, 1);
  const start = Math.max(0, Math.min(92, (lower / horizon) * 100));
  const end = Math.max(start + 2, Math.min(100, (upper / horizon) * 100));
  const eta = Math.max(start, Math.min(end, (median / horizon) * 100));

  elements.track.style.setProperty("--window-start", `${start.toFixed(2)}%`);
  elements.track.style.setProperty("--window-width", `${(end - start).toFixed(2)}%`);
  elements.track.style.setProperty("--eta-position", `${eta.toFixed(2)}%`);
  elements.track.setAttribute("aria-label", `预计到达窗口：${rangeText}`);
}

function inferDirection(previous, next) {
  const previousEta = numberOrNull(previous?.forecast?.p50Minutes);
  const nextEta = numberOrNull(next?.forecast?.p50Minutes);
  if (previousEta === null || nextEta === null) return "steady";
  if (nextEta > previousEta + 0.15) return "longer";
  if (nextEta < previousEta - 0.15) return "shorter";
  return "steady";
}

function projectionRevisionKey(projection) {
  return `${projection.selectionId || "global"}:${projection.scope || activeScope}`;
}

function renderProjection(projection) {
  if (!projection?.display) throw new Error("服务器返回的状态缺少 display 字段");

  if (activeMode === "live") {
    if (selectedSelectionId && projection.selectionId && projection.selectionId !== selectedSelectionId) return false;
    if (projection.scope && projection.scope !== activeScope) return false;
    const revision = numberOrNull(projection.projectionRevision);
    if (revision !== null) {
      const key = projectionRevisionKey(projection);
      const previousRevision = renderedRevisions.get(key);
      if (previousRevision !== undefined && revision < previousRevision) return false;
      renderedRevisions.set(key, revision);
    }
  }

  const previous = latestProjection;
  latestProjection = projection;
  const display = projection.display;
  const tone = display.tone || "working";

  elements.headline.textContent = display.headline || "ETA 暂不可用";
  elements.remaining.textContent = display.remaining || "剩余时间暂不可用";
  elements.etaStatus.textContent = display.statusLabel || "状态未知";
  elements.confidence.textContent = display.confidenceLabel || "证据：暂不可用";
  elements.range.textContent = display.range || "—";
  elements.currentStep.textContent = display.currentStep || "—";
  elements.reason.textContent = display.reason || "暂无变化";
  elements.arrival.dataset.tone = tone;
  elements.arrival.dataset.direction = inferDirection(previous, projection);
  updateTrack(projection.forecast, display.range);

  if (activeMode === "demo" && projection.fixtureId && elements.fixtureSelect.value !== projection.fixtureId) {
    elements.fixtureSelect.value = projection.fixtureId;
  }

  if (activeMode === "demo") {
    const atEnd = Number(projection.cursor) >= Number(projection.eventCount);
    elements.nextButton.disabled = requestPending || atEnd;
    elements.nextLabel.textContent = atEnd ? "回放已完成" : "推进一个事件";
  }
  return true;
}

function emptyProjection({ headline, range, reason, remaining = "剩余时间暂不可用" }) {
  return {
    kind: "live_empty",
    available: false,
    display: {
      headline,
      remaining,
      range,
      currentStep: "—",
      reason,
      tone: "empty",
      status: "unknown",
      statusLabel: "状态未知",
      confidence: "unavailable",
      confidenceLabel: "证据：暂不可用",
    },
    forecast: {
      mode: "unavailable",
      status: "unavailable",
      p50Minutes: null,
      p80Minutes: null,
      lowerMinutes: null,
    },
  };
}

const LIVE_EMPTY_STATES = {
  loading: {
    headline: "正在接入实时任务…",
    range: "等待首个真实事件",
    reason: "演示数据已清空；正在读取监听状态",
  },
  disabled: {
    headline: "实时监听未启用",
    range: "当前没有实时 ETA",
    reason: "监听关闭时不会沿用演示数据或旧快照",
  },
  degraded: {
    headline: "实时监听暂时降级",
    range: "当前 ETA 不足以可靠显示",
    reason: "等待监听恢复；不会用旧数据假装实时",
  },
  stale: {
    headline: "正在等待新任务",
    range: "新事件到达后会显示预计完成时间",
    reason: "上一条任务快照已经过期；不会把旧 ETA 当作实时状态",
  },
  error: {
    headline: "实时监听暂不可用",
    range: "当前没有可信 ETA",
    reason: "监听报告错误；不会保留演示结果",
  },
  stopped: {
    headline: "实时监听尚未运行",
    range: "当前没有实时 ETA",
    reason: "等待本机实时监听启动",
  },
  no_data: {
    headline: "正在等待真实任务",
    range: "捕获事件后会显示预计完成时间",
    reason: "监听已连接；尚无可显示的运行中任务",
  },
  connection: {
    headline: "无法连接实时监听",
    range: "当前没有可信 ETA",
    reason: "状态读取失败；演示数据不会在这里出现",
  },
};

function renderLiveEmpty(state) {
  const content = LIVE_EMPTY_STATES[state] || LIVE_EMPTY_STATES.connection;
  renderProjection(emptyProjection(content));
}

async function refreshState() {
  const projection = await requestJSON("/api/state");
  if (activeMode === "demo") {
    renderProjection(projection);
    showError("");
  }
}

function normalizeWatcherStatus(value) {
  if (!value || value.kind !== "live_watch_status") {
    throw new Error("实时监听状态格式不正确");
  }
  return {
    kind: value.kind,
    enabled: value.enabled === true,
    running: value.running === true,
    status: typeof value.status === "string" ? value.status : "unknown",
    lastScanAt: value.lastScanAt || null,
    lastSuccessAt: value.lastSuccessAt || null,
    lastChangeAt: value.lastChangeAt || null,
    errorCode: value.errorCode || null,
    pollIntervalMs: numberOrNull(value.pollIntervalMs),
  };
}

function watcherHealth(status) {
  const value = String(status?.status || "").toLowerCase();
  if (!status?.enabled || value === "disabled") return "disabled";
  if (status.errorCode || ["error", "failed"].includes(value)) return "error";
  if (value === "stale") return "stale";
  if (value === "degraded") return "degraded";
  if (status.running) return "running";
  if (["starting", "initializing"].includes(value)) return "starting";
  return "stopped";
}

function timeLabel(value, prefix) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return `${prefix} ${new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))}`;
}

function renderWatcher(status, snapshot = null) {
  watcherStatus = status;
  const health = watcherHealth(status);
  const label = {
    running: "实时监听中",
    starting: "正在启动监听",
    stopped: "监听尚未运行",
    disabled: "监听未启用",
    degraded: "监听已降级",
    stale: "等待新任务",
    error: "监听异常",
  }[health];
  const detail = {
    running: "结构化事件到达后自动更新",
    starting: "等待实时监听就绪",
    stopped: "等待实时监听启动",
    disabled: "需要先启用本机实时监听",
    degraded: "正在等待下一次成功采集",
    stale: "监听正常；等待新的结构化事件",
    error: "实时监听未提供可信的最新状态",
  }[health];
  elements.watcherState.dataset.status = health;
  elements.watcherStateText.textContent = label;
  elements.watcherDetail.textContent = detail;

  const captured = health === "running" && snapshot?.available
    ? (snapshot.capturedLabel || timeLabel(snapshot.capturedAt, "采集于"))
    : null;
  const observed = captured
    || timeLabel(status.lastScanAt, "扫描于")
    || timeLabel(status.lastSuccessAt, "最近成功")
    || timeLabel(status.lastChangeAt, "状态更新于")
    || "尚未采集";
  elements.watcherTime.textContent = observed;
  elements.watcherTime.dateTime = (health === "running" ? snapshot?.capturedAt : null)
    || status.lastScanAt
    || status.lastSuccessAt
    || status.lastChangeAt
    || "";
  return health;
}

function renderWatcherConnectionError() {
  renderWatcher({
    kind: "live_watch_status",
    enabled: true,
    running: false,
    status: "error",
    lastScanAt: null,
    lastSuccessAt: null,
    lastChangeAt: null,
    errorCode: "status_unavailable",
    pollIntervalMs: null,
  });
}

function safeActiveSelections(payload) {
  if (!payload || payload.kind !== "live_active" || !Array.isArray(payload.selections)) return [];
  return payload.selections.filter((item) => (
    typeof item?.selectionId === "string"
    && /^sel-[a-f0-9]{20}$/.test(item.selectionId)
    && typeof item.status === "string"
  ));
}

function preferredScope(item) {
  const scope = item?.meta?.defaultScope;
  return ["run", "task", "project"].includes(scope) ? scope : "run";
}

function activeOptionLabel(item, index) {
  const status = {
    working: "工作中",
    needs_input: "等你回复",
    waiting_provider: "等待服务",
    blocked: "已阻塞",
    paused: "已暂停",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  }[item.status] || "状态未知";
  return `实时对象 ${index + 1} · ${status}`;
}

function renderActiveSelections(payload) {
  const selections = safeActiveSelections(payload);
  preferredScopes.clear();
  for (const item of selections) preferredScopes.set(item.selectionId, preferredScope(item));
  const replacements = selectedSelectionId
    ? selections.filter((item) => item?.meta?.replacesSelectionId === selectedSelectionId)
    : [];
  if (replacements.length === 1) {
    selectedSelectionId = replacements[0].selectionId;
    activeScope = preferredScopes.get(selectedSelectionId) || "run";
    updateScopeControls();
  }
  const adoptedDefault = !selectedSelectionId && typeof payload?.defaultSelectionId === "string";
  if (!selectedSelectionId && typeof payload?.defaultSelectionId === "string") {
    selectedSelectionId = payload.defaultSelectionId;
  }
  if (adoptedDefault) {
    activeScope = preferredScopes.get(selectedSelectionId) || "run";
    updateScopeControls();
  }
  const visible = [...selections];
  if (selectedSelectionId && !visible.some((item) => item.selectionId === selectedSelectionId)) {
    visible.unshift({ selectionId: selectedSelectionId, status: "unknown", pinned: true });
  }
  const options = visible.map((item, index) => {
    const option = document.createElement("option");
    option.value = item.selectionId;
    option.textContent = item.pinned ? "已选对象 · 等待更新" : activeOptionLabel(item, index);
    return option;
  });
  if (!options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "等待真实任务";
    options.push(option);
  }
  elements.activeSelect.replaceChildren(...options);
  elements.activeSelect.value = selectedSelectionId || "";
}

function updateScopeControls() {
  for (const [scope, button] of Object.entries(scopeButtons)) {
    const active = scope === activeScope;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  const label = { run: "本轮", task: "任务", project: "项目" }[activeScope];
  elements.eyebrow.textContent = activeMode === "live"
    ? `预计到达 · 实时${label}`
    : "预计到达 · 演示路线";
}

function liveLatestUrl() {
  const selection = selectedSelectionId
    ? `selection=${encodeURIComponent(selectedSelectionId)}&`
    : "";
  return `/api/live/latest?${selection}scope=${encodeURIComponent(activeScope)}`;
}

function liveStatusUrl() {
  const selection = selectedSelectionId
    ? `selection=${encodeURIComponent(selectedSelectionId)}&`
    : "";
  return `/api/live/status?${selection}scope=${encodeURIComponent(activeScope)}`;
}

function isTerminalProjection(snapshot) {
  return ["succeeded", "failed", "cancelled"].includes(snapshot?.status || snapshot?.display?.status);
}

function clearFallbackTimer() {
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

function scheduleLiveFallback() {
  clearFallbackTimer();
  if (activeMode !== "live") return;
  const requested = watcherStatus?.pollIntervalMs ?? LIVE_FALLBACK_MIN_MS;
  const interval = Math.max(
    LIVE_FALLBACK_MIN_MS,
    Math.min(LIVE_FALLBACK_MAX_MS, requested * 2),
  );
  fallbackTimer = setTimeout(() => {
    refreshLive().catch(() => {
      // refreshLive renders the fail-closed state; the next fallback remains scheduled.
    });
  }, interval);
}

async function refreshLive() {
  if (activeMode !== "live") return;
  if (liveRefreshPending) {
    liveRefreshQueued = true;
    return;
  }

  const revision = modeRevision;
  const queryRevision = liveQueryRevision;
  setLiveRefreshPending(true);

  try {
    const activeResult = await Promise.allSettled([requestJSON("/api/live/active")]);
    if (activeMode !== "live" || revision !== modeRevision || queryRevision !== liveQueryRevision) return;
    if (activeResult[0].status === "fulfilled") renderActiveSelections(activeResult[0].value);

    const selectedAtRequest = selectedSelectionId;
    const scopeAtRequest = activeScope;
    const [statusResult, latestResult] = await Promise.allSettled([
      requestJSON(liveStatusUrl()),
      requestJSON(liveLatestUrl()),
    ]);
    if (
      activeMode !== "live"
      || revision !== modeRevision
      || queryRevision !== liveQueryRevision
      || selectedAtRequest !== selectedSelectionId
      || scopeAtRequest !== activeScope
    ) return;
    if (statusResult.status !== "fulfilled") {
      renderWatcherConnectionError();
      renderLiveEmpty("connection");
      showError(statusResult.reason?.message || "实时监听状态不可用");
      return;
    }

    let status;
    try {
      status = normalizeWatcherStatus(statusResult.value);
    } catch (error) {
      renderWatcherConnectionError();
      renderLiveEmpty("connection");
      showError(error.message);
      return;
    }

    const snapshot = latestResult.status === "fulfilled" ? latestResult.value : null;
    const health = renderWatcher(status, snapshot);
    if (snapshot?.display && isTerminalProjection(snapshot)) {
      renderProjection(snapshot);
      showError(health === "running" ? "" : "最终结果已保存；监听当前未运行");
      return;
    }
    if (health !== "running") {
      renderLiveEmpty(health);
      showError("");
      return;
    }
    if (latestResult.status !== "fulfilled") {
      renderLiveEmpty("connection");
      showError(latestResult.reason?.message || "实时任务数据不可用");
      return;
    }
    if (!snapshot?.available && !snapshot?.display) {
      renderLiveEmpty("no_data");
      showError("");
      return;
    }
    if (!snapshot?.available && !selectedSelectionId && activeScope === "run") {
      renderLiveEmpty("no_data");
      showError("");
      return;
    }
    renderProjection(snapshot);
    showError("");
  } finally {
    setLiveRefreshPending(false);
    scheduleLiveFallback();
    if (liveRefreshQueued && activeMode === "live") {
      liveRefreshQueued = false;
      queueMicrotask(() => refreshLive());
    }
  }
}

function fixtureItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.fixtures)) return payload.fixtures;
  return [];
}

function fixtureId(fixture) {
  return fixture.id || fixture.fixtureId;
}

function fixtureTitle(fixture) {
  return fixture.title || fixture.fixtureTitle || fixture.label || fixtureId(fixture);
}

async function loadFixtures() {
  const payload = await requestJSON("/api/fixtures");
  const fixtures = fixtureItems(payload);
  if (!fixtures.length) throw new Error("没有可回放的场景");

  elements.fixtureSelect.replaceChildren(
    ...fixtures.map((fixture) => {
      const option = document.createElement("option");
      option.value = fixtureId(fixture);
      option.textContent = fixtureTitle(fixture);
      return option;
    }),
  );
  elements.fixtureSelect.disabled = false;
  elements.resetButton.disabled = false;
}

async function runAction(action) {
  if (requestPending) return;
  setPending(true);
  showError("");
  try {
    const result = await action();
    if (result?.display) renderProjection(result);
    else await refreshState();
  } catch (error) {
    showError(error.message || "未知错误");
  } finally {
    setPending(false);
  }
}

async function resetFixture() {
  const selectedFixture = elements.fixtureSelect.value;
  if (!selectedFixture) return;
  await runAction(() =>
    requestJSON("/api/replay/reset", {
      method: "POST",
      body: JSON.stringify({ fixtureId: selectedFixture }),
    }),
  );
}

function handleLiveSignal() {
  if (activeMode === "live") {
    refreshLive().catch((error) => showError(error.message || "实时更新失败"));
  }
}

function parseStreamPayload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource("/api/stream");
  eventSource.onmessage = (event) => {
    const payload = parseStreamPayload(event);
    if (payload?.kind === "live_update") handleLiveSignal();
    else if (activeMode === "demo" && !requestPending) {
      refreshState().catch((error) => showError(error.message));
    }
  };
  eventSource.addEventListener("live", handleLiveSignal);
  eventSource.addEventListener("live_update", handleLiveSignal);
  const refreshDemo = () => {
    if (activeMode === "demo" && !requestPending) {
      refreshState().catch((error) => showError(error.message));
    }
  };
  eventSource.addEventListener("state", refreshDemo);
  eventSource.addEventListener("invalidate", refreshDemo);
}

async function selectMode(mode) {
  if (!["demo", "live"].includes(mode) || (mode === activeMode && latestProjection)) return;
  modeRevision += 1;
  activeMode = mode;
  latestProjection = null;
  liveRefreshQueued = false;
  clearFallbackTimer();
  const live = mode === "live";
  if (!live) activeScope = "run";
  elements.demoMode.classList.toggle("is-active", !live);
  elements.liveMode.classList.toggle("is-active", live);
  elements.demoMode.setAttribute("aria-pressed", String(!live));
  elements.liveMode.setAttribute("aria-pressed", String(live));
  elements.controls.hidden = live;
  elements.liveControls.hidden = !live;
  elements.activeField.hidden = !live;
  updateScopeControls();
  elements.arrival.dataset.source = mode;
  showError("");

  setPending(true);
  try {
    if (live) {
      renderWatcher({
        kind: "live_watch_status",
        enabled: true,
        running: false,
        status: "starting",
        lastScanAt: null,
        lastSuccessAt: null,
        lastChangeAt: null,
        errorCode: null,
        pollIntervalMs: null,
      });
      // Clear the previous Demo synchronously, before either live request can resolve.
      renderLiveEmpty("loading");
      await refreshLive();
    } else {
      await refreshState();
    }
  } catch (error) {
    if (live) {
      renderWatcherConnectionError();
      renderLiveEmpty("connection");
    }
    showError(error.message || "无法切换数据源");
  } finally {
    setPending(false);
  }
}

elements.controls.addEventListener("submit", (event) => {
  event.preventDefault();
  runAction(() => requestJSON("/api/replay/next", { method: "POST", body: "{}" }));
});

elements.resetButton.addEventListener("click", resetFixture);
elements.fixtureSelect.addEventListener("change", resetFixture);
elements.demoMode.addEventListener("click", () => selectMode("demo"));
elements.liveMode.addEventListener("click", () => selectMode("live"));
for (const [scope, button] of Object.entries(scopeButtons)) {
  button.addEventListener("click", () => {
    if (activeMode !== "live" || activeScope === scope) return;
    activeScope = scope;
    liveQueryRevision += 1;
    latestProjection = null;
    updateScopeControls();
    renderLiveEmpty("loading");
    refreshLive().catch((error) => showError(error.message || "无法切换 ETA 范围"));
  });
}
elements.activeSelect.addEventListener("change", () => {
  if (activeMode !== "live") return;
  selectedSelectionId = elements.activeSelect.value || null;
  activeScope = preferredScopes.get(selectedSelectionId) || "run";
  liveQueryRevision += 1;
  latestProjection = null;
  updateScopeControls();
  renderLiveEmpty("loading");
  refreshLive().catch((error) => showError(error.message || "无法切换实时对象"));
});
elements.liveRefresh.addEventListener("click", () => {
  if (activeMode !== "live" || liveRefreshPending) return;
  setPending(true);
  refreshLive()
    .catch((error) => showError(error.message || "实时更新失败"))
    .finally(() => setPending(false));
});
window.addEventListener("beforeunload", () => {
  clearFallbackTimer();
  eventSource?.close();
});

async function initialize() {
  setPending(true);
  try {
    await loadFixtures();
    await refreshState();
    elements.arrival.dataset.source = "demo";
    elements.activeField.hidden = true;
    updateScopeControls();
    connectStream();
  } catch (error) {
    showError(error.message || "初始化失败");
  } finally {
    setPending(false);
  }
}

initialize();
