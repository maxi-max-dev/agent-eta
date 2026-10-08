const MAX_ID_LENGTH = 256;
const MAX_ATOM_LENGTH = 64;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ALLOWED_KEYS = new Set([
  // Safe session-scan input fields.
  "provider",
  "sessionId",
  "startedAt",
  "endedAt",
  "status",
  "eventCount",
  "planEventCount",
  "corruptEventCount",
  "eligibleLargeTask",
  "hasPlan",
  "class",
  "taskClass",
  "label",

  // Aggregate coverage output fields.
  "simulated",
  "liveReadOnly",
  "totalSessions",
  "eligibility",
  "definition",
  "supported",
  "eligibleSessions",
  "eligiblePlanSessions",
  "planSessions",
  "coverage",
  "events",
  "total",
  "corrupt",
  "rate",
  "timeRange",
  "from",
  "to",
]);

const ID_KEYS = new Set(["sessionId"]);
const TIMESTAMP_KEYS = new Set(["startedAt", "endedAt", "from", "to"]);
const GENERALIZED_ATOM_KEYS = new Set([
  "provider",
  "status",
  "class",
  "taskClass",
  "label",
  "definition",
]);

const FORBIDDEN_KEY_PARTS = [
  "prompt",
  "content",
  "message",
  "transcript",
  "正文",
  "command",
  "code",
  "script",
  "query",
  "response",
  "request",
  "body",
  "text",
  "markdown",
  "html",
  "path",
  "cwd",
  "directory",
  "filename",
  "filepath",
  "argv",
  "args",
  "environment",
  "secret",
  "token",
  "apikey",
  "password",
];

const COMMAND_ATOMS = new Set([
  "bash",
  "cat",
  "cd",
  "chmod",
  "chown",
  "curl",
  "eval",
  "exec",
  "git",
  "node",
  "npm",
  "npx",
  "perl",
  "powershell",
  "python",
  "python3",
  "rm",
  "ruby",
  "sh",
  "ssh",
  "sudo",
  "wget",
  "zsh",
]);

function fail(path, reason) {
  throw new TypeError(`Privacy-unsafe value at ${path}: ${reason}`);
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[_-]/g, "");
}

function assertSafeKey(key, path) {
  const normalized = normalizedKey(key);
  const forbidden = FORBIDDEN_KEY_PARTS.find((part) => normalized.includes(part));
  if (forbidden) {
    fail(path, `key '${key}' may contain ${forbidden} data`);
  }
  if (!ALLOWED_KEYS.has(key)) {
    fail(path, `key '${key}' is not in the structural-metadata allowlist`);
  }
}

function isAbsolutePath(value) {
  return (
    value.startsWith("/") ||
    value.startsWith("file://") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("\\\\")
  );
}

function assertSafeString(value, key, path) {
  if (value.length === 0) fail(path, "empty strings are not valid metadata");
  if (value.length > MAX_ID_LENGTH) fail(path, "long free text is forbidden");
  if (/\r|\n|\0/.test(value)) fail(path, "multiline or NUL text is forbidden");
  if (isAbsolutePath(value)) fail(path, "absolute paths are forbidden");

  if (TIMESTAMP_KEYS.has(key)) {
    if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
      fail(path, "timestamp must be an ISO 8601 instant");
    }
    return;
  }

  if (ID_KEYS.has(key)) {
    if (
      value.length > MAX_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)
    ) {
      fail(path, "ID must be an opaque path-free token");
    }
    return;
  }

  if (GENERALIZED_ATOM_KEYS.has(key) || key === null) {
    if (
      value.length > MAX_ATOM_LENGTH ||
      !/^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(value)
    ) {
      fail(path, "labels must be short generalized atoms, not free text");
    }
    if (COMMAND_ATOMS.has(value.toLowerCase())) {
      fail(path, "command names are forbidden even when disguised as labels");
    }
    return;
  }

  // Every currently allowed string-bearing key is classified above. Keeping
  // this branch closed prevents a later allowlisted field from silently
  // becoming a free-text channel.
  fail(path, "string value has no explicitly safe metadata type");
}

/**
 * Assert that a value contains structural metadata only.
 *
 * The policy is deliberately allowlist-based. It rejects accessors, custom
 * prototypes, unknown keys, prompt/message/code/command fields, absolute
 * paths, multiline strings and long free text. The original value is returned
 * so callers can use this at module boundaries without cloning it.
 */
export function assertPrivacySafe(value) {
  const active = new WeakSet();

  function visit(current, path, key = null) {
    if (current === null) return;

    if (typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(path, "numbers must be finite");
      return;
    }
    if (typeof current === "string") {
      assertSafeString(current, key, path);
      return;
    }
    if (typeof current !== "object") {
      fail(path, `unsupported ${typeof current} value`);
    }

    if (active.has(current)) fail(path, "cyclic objects are forbidden");
    active.add(current);

    if (Array.isArray(current)) {
      for (const ownKey of Reflect.ownKeys(current)) {
        if (ownKey === "length") continue;
        if (typeof ownKey !== "string" || !/^(?:0|[1-9]\d*)$/.test(ownKey)) {
          fail(path, "custom or symbol array properties are forbidden");
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const childPath = `${path}[${index}]`;
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        if (!descriptor) fail(childPath, "sparse arrays are forbidden");
        if (!("value" in descriptor)) fail(childPath, "accessor properties are forbidden");
        visit(descriptor.value, childPath, null);
      }
      active.delete(current);
      return;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, "only plain objects are accepted");
    }

    for (const ownKey of Reflect.ownKeys(current)) {
      if (typeof ownKey !== "string") fail(path, "symbol keys are forbidden");
      const childPath = `${path}.${ownKey}`;
      assertSafeKey(ownKey, childPath);
      const descriptor = Object.getOwnPropertyDescriptor(current, ownKey);
      if (!descriptor || !("value" in descriptor)) {
        fail(childPath, "accessor properties are forbidden");
      }
      visit(descriptor.value, childPath, ownKey);
    }

    active.delete(current);
  }

  visit(value, "$", null);
  return value;
}
