import { isObject } from './is-object.js';
import { preventPollution } from './prevent-pollution.js';
/**
 * Sets a nested value on the target object using a path array, creating
 * intermediate plain objects as needed.
 *
 * Unlike json-magic's `setValueAtPath` (which accepts a JSON-pointer string and
 * creates arrays for numeric segments), this helper uses an array of string
 * segments and only ever creates plain objects. It mirrors the shape of
 * `getValueAtPath` so the two compose cleanly.
 *
 * @example
 * ```ts
 * const target = {}
 * setValueAtPath(target, ['filter', 'status'], 'active')
 *
 * { filter: { status: 'active' } }
 * ```
 */
export const setValueAtPath = (target, path, value) => {
    const [key, ...rest] = path;
    if (!key) {
        return;
    }
    preventPollution(key);
    if (!rest.length) {
        target[key] = value;
        return;
    }
    const next = isObject(target[key]) ? target[key] : {};
    target[key] = next;
    setValueAtPath(next, rest, value);
};
