import { type Result } from './result.js';
/**
 * Run a function and capture any thrown error as a {@link Result} so callers
 * never have to write `try/catch` themselves.
 *
 * **Overload:** when `fn` returns a `Promise`, the return type is
 * `Promise<Result<T>>` and rejections become `err(message)` — the promise
 * never rejects.
 *
 * **Overload:** when `fn` returns a plain value synchronously, the return type
 * is `Result<T>` with no promise wrapper. You may still `await` that value;
 * it behaves like an immediate result.
 *
 * Failures are logged with `console.error` so unexpected errors stay visible
 * in devtools while the caller decides how to present them to the user.
 *
 * @example Async (always `await` the outer promise)
 * const outcome = await safeRun(() => fetcher())
 * isLoading.value = false
 * if (!outcome.ok) {
 *   toast(outcome.error, 'error')
 *   return
 * }
 * useData(outcome.data)
 *
 * @example Sync (no `await` required)
 * const outcome = safeRun(() => JSON.parse(raw))
 * if (!outcome.ok) {
 *   toast(outcome.error, 'error')
 *   return
 * }
 * useData(outcome.data)
 */
export declare function safeRun<T>(fn: () => Promise<T>): Promise<Result<T>>;
export declare function safeRun<T>(fn: () => T): Result<T>;
//# sourceMappingURL=safe-run.d.ts.map