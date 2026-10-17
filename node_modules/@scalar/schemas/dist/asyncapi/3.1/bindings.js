import { object, optional, unknown } from '@scalar/validation';
import { asyncApiWsBindingObject } from './ws-binding.js';
/**
 * Protocol keys listed for binding objects in AsyncAPI 3.1.0. Values are
 * protocol-specific; we accept any JSON-compatible structure.
 */
const ASYNCAPI_3_1_BINDING_PROTOCOL_KEYS = [
    'http',
    'ws',
    'kafka',
    'anypointmq',
    'amqp',
    'amqp1',
    'mqtt',
    'mqtt5',
    'nats',
    'jms',
    'sns',
    'solace',
    'sqs',
    'stomp',
    'redis',
    'mercure',
    'ibmmq',
    'googlepubsub',
    'pulsar',
    'ros2',
];
const optionalBindingPayload = () => optional(unknown({
    typeComment: 'Protocol-specific binding definition (see AsyncAPI protocol bindings).',
}));
const bindingObjectProperties = () => {
    const properties = {};
    for (const key of ASYNCAPI_3_1_BINDING_PROTOCOL_KEYS) {
        properties[key] = key === 'ws' ? optional(asyncApiWsBindingObject) : optionalBindingPayload();
    }
    return properties;
};
const makeBindingsObject = (typeName, typeComment) => object(bindingObjectProperties(), { typeName, typeComment });
export const asyncApiServerBindingsObject = makeBindingsObject('AsyncApiServerBindingsObject', 'Map describing protocol-specific definitions for a server (AsyncAPI 3.1.0).');
export const asyncApiChannelBindingsObject = makeBindingsObject('AsyncApiChannelBindingsObject', 'Map describing protocol-specific definitions for a channel (AsyncAPI 3.1.0).');
export const asyncApiOperationBindingsObject = makeBindingsObject('AsyncApiOperationBindingsObject', 'Map describing protocol-specific definitions for an operation (AsyncAPI 3.1.0).');
export const asyncApiMessageBindingsObject = makeBindingsObject('AsyncApiMessageBindingsObject', 'Map describing protocol-specific definitions for a message (AsyncAPI 3.1.0).');
