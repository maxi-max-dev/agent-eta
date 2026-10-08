import { sanitizeReporterReport } from './contract.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function reporterEndpoint(value = 'http://127.0.0.1:4318') {
  const endpoint = new URL('/api/reporter', value);
  if (endpoint.protocol !== 'http:'
      || !LOOPBACK_HOSTS.has(endpoint.hostname)
      || endpoint.username
      || endpoint.password) {
    throw new Error('REPORTER_LOOPBACK_REQUIRED');
  }
  return endpoint;
}

export async function submitReporterReport(report, {
  baseUrl = 'http://127.0.0.1:4318',
  fetchImpl = fetch,
} = {}) {
  const sanitized = sanitizeReporterReport(report);
  const response = await fetchImpl(reporterEndpoint(baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sanitized),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('REPORTER_INVALID_RESPONSE');
  }
  if (!response.ok) throw new Error(body?.error ?? 'REPORTER_REQUEST_FAILED');
  return body;
}
