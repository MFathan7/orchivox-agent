/** All OpenAPI HTTP methods */
export const HTTP_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'query', 'trace'];
/** Set of all http methods we support */
export const httpMethods = Object.freeze(new Set(HTTP_METHODS));
