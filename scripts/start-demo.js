import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A first launch uses only synthetic replay fixtures. Live observation is explicit.
console.log('AgentWhen demo: synthetic examples only; local task watcher is disabled.');
const child = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../src/server/main.js', import.meta.url))], {
  stdio: 'inherit',
  env: { ...process.env, AGENT_ETA_WATCH: '0', AGENT_ETA_WEEKLY_EVAL: '0' },
});
child.once('error', () => { console.error('Unable to start the demo server.'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
