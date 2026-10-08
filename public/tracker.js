const LABELS = { coding: '开发', research: '研究', review: '审查', writing: '写作', other: '其他' };
const OUTCOMES = { succeeded: '已完成', failed: '运行失败', cancelled: '已取消' };
const minutes = value => value < 1 ? '不到 1 分钟' : `${Math.round(value)} 分钟`;

export function presentation(run) {
  if (!run) return { headline: '还没有运行记录', explanation: '接入一条真实命令，运行状态就会出现在这里。开始积累自己的历史后，再给出实验性的剩余时间。', numeric: false };
  if (run.estimateStatus === 'terminal') return { headline: OUTCOMES[run.status] ?? '已结束', explanation: '这是上报的运行结果；任务内容仍需单独验收。', numeric: false };
  if (run.estimateStatus === 'paused') return { headline: '已暂停，等你回来', explanation: '暂停时间不计入活跃耗时，恢复工作后再继续估计。', numeric: false };
  if (run.estimateStatus === 'stale') return { headline: '观测已过期', explanation: '超过 60 秒没有收到真实上报，已撤下时间估计。刷新页面不会产生心跳。', numeric: false };
  if (run.estimateStatus === 'observation_gap') return { headline: '运行中，观测曾中断', explanation: '已经重新收到上报，但中断期间的活跃耗时无法确认。这次不再给出数字，也不进入训练历史。', numeric: false };
  if (run.estimateStatus === 'cold_start') return { headline: '运行中，正在积累历史', explanation: `已有 ${run.historyCount} 次有效同类记录，至少需要 ${run.minimumHistory} 次才显示实验估计。这个门槛不代表准确度已获验证。`, numeric: false };
  if (run.estimateStatus === 'experimental' && run.remainingMinutes) return { headline: `预计还需 ${minutes(run.remainingMinutes.p50)}`, explanation: '根据相同 Agent / 工作流的已完成记录估计。长任务仍可能低估，时间值会随运行情况调整。', numeric: true };
  return { headline: '暂时无法估计', explanation: '等待可解释的运行状态。', numeric: false };
}

if (typeof document !== 'undefined') {
  const el = id => document.getElementById(id);
  let selected = null;
  let runs = [];
  let connected = false;
  const time = iso => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  function render() {
    const run = runs.find(item => item.runId === selected) ?? null;
    const view = presentation(run);
    el('headline').textContent = view.headline;
    el('explanation').textContent = view.explanation;
    el('range').hidden = !view.numeric;
    el('facts').hidden = !run;
    el('setup').hidden = Boolean(run);
    el('receipt').hidden = !run?.forecastId;
    el('run-label').textContent = run ? `${run.profile} · ${LABELS[run.taskClass] ?? run.taskClass}` : '本机运行 · 实验版本';
    if (run) {
      el('elapsed').textContent = minutes(run.activeMinutes);
      el('history').textContent = `${run.historyCount} 次`;
      el('observed').textContent = time(run.observedAt);
      el('estimated').textContent = time(run.estimatedAt);
      if (view.numeric) el('range-value').textContent = `${run.remainingMinutes.p20}–${run.remainingMinutes.p80} 分钟`;
    }
  }
  function disconnected() {
    connected = false;
    el('connection').textContent = '连接中断 · 正在重试';
    el('connection').dataset.state = 'error';
    el('headline').textContent = '本机服务暂不可用';
    el('explanation').textContent = '已撤下旧估计。确认服务仍在运行；恢复连接后会自动刷新。';
    el('range').hidden = true;
    el('facts').hidden = true;
    el('receipt').hidden = true;
  }
  el('run-select').addEventListener('change', event => { selected = event.target.value; if (connected) render(); else disconnected(); });
  async function poll() {
    try {
      const response = await fetch('/api/tracker/runs', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json();
      if (!body.enabled) throw new Error('disabled');
      runs = body.runs;
      connected = true;
      if (!runs.some(run => run.runId === selected)) selected = runs.find(run => run.status === 'running')?.runId ?? runs[0]?.runId ?? null;
      el('run-select').replaceChildren(...runs.map(run => {
        const option = document.createElement('option');
        option.value = run.runId;
        option.textContent = `${run.profile} · ${LABELS[run.taskClass] ?? run.taskClass} · ${time(run.startedAt)} · ${run.runId.slice(-6)}`;
        return option;
      }));
      el('run-select').value = selected ?? '';
      el('picker').hidden = !runs.length;
      el('connection').textContent = '已连接 · 每 5 秒刷新';
      el('connection').dataset.state = 'connected';
      render();
    } catch { disconnected(); }
    setTimeout(poll, 5000);
  }
  void poll();
}
