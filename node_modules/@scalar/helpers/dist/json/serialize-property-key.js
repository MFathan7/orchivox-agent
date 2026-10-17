import { escapeJsonForInlineScript } from './escape-json-for-inline-script.js';
/** Serialize a property name for a JavaScript object literal inside an inline script. */
export const serializePropertyKey = (key) => escapeJsonForInlineScript(JSON.stringify(key));
