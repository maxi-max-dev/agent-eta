// Node's after hooks run in registration order. Dispose resources in reverse
// acquisition order so Windows never removes a still-open SQLite file.
const stacks = new WeakMap();
export function afterCleanup(context, dispose) {
  let stack = stacks.get(context);
  if (!stack) {
    stack = [];
    stacks.set(context, stack);
    context.after(async () => {
      const errors = [];
      for (const action of stack.reverse()) {
        try { await action(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Resource cleanup failed');
    });
  }
  stack.push(dispose);
}
