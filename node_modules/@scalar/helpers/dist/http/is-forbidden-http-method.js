/** Methods forbidden by the Fetch standard, irrespective of their body semantics. */
export const isForbiddenHttpMethod = (method) => ['connect', 'trace', 'track'].includes(method.toLowerCase());
