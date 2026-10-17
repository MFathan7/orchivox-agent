import { array, lazy, object, optional } from '@scalar/validation';
import { asyncApiChannelObject } from './channel.js';
import { asyncApiMessageObject } from './message.js';
import { asyncApiOperationReplyAddressObject } from './operation-reply-address.js';
import { asyncApiResolvedReference, recursiveRef } from './reference.js';
/** Operation Reply Object | Reference Object */
export const asyncApiOperationReplyObject = lazy(() => recursiveRef(object({
    address: optional(asyncApiOperationReplyAddressObject),
    channel: optional(asyncApiResolvedReference(asyncApiChannelObject)),
    messages: optional(array(asyncApiResolvedReference(asyncApiMessageObject), {
        typeComment: 'List of $ref pointers to Message Objects used as reply payloads (Reference Objects only in the raw document).',
    })),
}, { typeName: 'AsyncApiOperationReplyObject' })));
