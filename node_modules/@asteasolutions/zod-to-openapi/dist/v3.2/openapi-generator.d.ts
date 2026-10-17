import type { OpenAPIObject } from 'openapi3-ts/oas32';
import { OpenApiGeneratorOptions } from '../openapi-generator';
import { ZodType } from 'zod';
import { OpenAPIDefinitions } from '../openapi-registry';
export type OpenAPIObjectConfigV32 = Omit<OpenAPIObject, 'paths' | 'components' | 'webhooks'>;
export declare class OpenApiGeneratorV32 {
    private definitions;
    private generator;
    private webhookRefs;
    constructor(definitions: (OpenAPIDefinitions | ZodType)[], options?: OpenApiGeneratorOptions);
    generateDocument(config: OpenAPIObjectConfigV32): OpenAPIObject;
    generateComponents(): Pick<OpenAPIObject, 'components'>;
    private generateWebhooks;
    private generateSingleWebhook;
}
