export async function* abortableStream<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!signal) { yield* source; return; }
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Request cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      signal.throwIfAborted();
      if (next.done) { completed = true; return; }
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    // A provider may ignore cancellation; it must not hold the foreground open.
    if (!completed) void iterator.return?.().catch(() => undefined);
  }
}
