import { err, ok } from './result.js';
const formatCaughtError = (error) => (error instanceof Error ? error.message : String(error));
export function safeRun(fn) {
    try {
        const out = fn();
        if (out instanceof Promise) {
            return out.then((data) => ok(data), (error) => {
                console.error(error);
                return err(formatCaughtError(error));
            });
        }
        return ok(out);
    }
    catch (error) {
        console.error(error);
        return err(formatCaughtError(error));
    }
}
