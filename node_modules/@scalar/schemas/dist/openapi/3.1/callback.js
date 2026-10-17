import { lazy, record, string } from '@scalar/validation';
import { pathItem } from '../../openapi/3.1/path-item.js';
import { recursiveRef } from '../../openapi/3.1/reference.js';
export const callback = record(string(), recursiveRef(lazy(() => pathItem)), {
    typeName: 'CallbackObject',
});
