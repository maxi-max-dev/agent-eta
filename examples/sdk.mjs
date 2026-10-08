import { AgentWhen } from '../src/generic/tracker.js';

// Replace the awaited operation with a real, bounded task.
// Use a separate profile for this wiring example; it is not real training data.
const tracker = new AgentWhen();
const { runId } = tracker.start({ profile: 'sdk-wiring-example', taskClass: 'other' });
const heartbeat = setInterval(() => tracker.ping(runId), 30_000);
try {
  console.log(tracker.status(runId));
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log(tracker.finish(runId));
} catch (error) {
  tracker.finish(runId, 'failed');
  throw error;
} finally {
  clearInterval(heartbeat);
  tracker.close();
}
