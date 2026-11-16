import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation";
import { catalogHash } from "./cache";

export class McpSchemaValidator implements jsonSchemaValidator {
  private readonly validators = new Map<string, JsonSchemaValidator<unknown>>();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const key = catalogHash(schema);
    let validator = this.validators.get(key);
    if (validator) this.validators.delete(key);
    else {
      // Server versions can reuse $id for different schemas. Keep their AJV registries separate.
      validator = new AjvJsonSchemaValidator().getValidator(schema);
      if (this.validators.size >= 256) this.validators.delete(this.validators.keys().next().value!);
    }
    this.validators.set(key, validator);
    return validator as JsonSchemaValidator<T>;
  }
}
