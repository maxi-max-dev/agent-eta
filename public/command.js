// Shell text is for a human clipboard. Tool callers should keep argument arrays.
export function formatCommand(args, shell = 'posix') {
  if (!['posix', 'powershell'].includes(shell) || !Array.isArray(args) || !args.length
    || args.some(value => typeof value !== 'string' || value.includes('\0'))) return '';
  // Windows PowerShell's native argument marshalling cannot reliably preserve
  // these strings. They cannot occur in the generated Windows file paths.
  if (shell === 'powershell' && args.some(value => value.includes('"') || value.endsWith('\\'))) return '';
  const quote = shell === 'powershell'
    ? value => `'${value.replaceAll("'", "''")}'`
    : value => `'${value.replaceAll("'", "'\\''")}'`;
  return `${shell === 'powershell' ? '& ' : ''}${args.map(quote).join(' ')}`;
}

export function onboardingCommand(setup, shell) {
  const args = setup?.commands?.start;
  if (setup?.status !== 'ready' || !Array.isArray(args) || args[2] !== 'start') return '';
  const prefix = formatCommand([...args.slice(0, 2), 'run', ...args.slice(3), '--'], shell);
  return prefix ? `${prefix} COMMAND` : '';
}
