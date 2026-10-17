import { OpenAPIRegistry, OpenApiGeneratorV3, RouteConfig as RouteConfig$1, ZodContentObject, ZodMediaTypeObject, ZodRequestBody, extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { Context, Env, ErrorHandler, Handler, Hono, Input, MiddlewareHandler, NotFoundHandler, Schema, ToSchema, TypedResponse, ValidationTargets } from "hono";
import { H, MergePath, MergeSchemaPath } from "hono/types";
import { ClientErrorStatusCode, InfoStatusCode, RedirectStatusCode, ServerErrorStatusCode, StatusCode, SuccessStatusCode } from "hono/utils/http-status";
import { JSONParsed, RemoveBlankRecord } from "hono/utils/types";
import { OpenAPIObject } from "openapi3-ts/oas30";
import { OpenAPIObject as OpenAPIObject$1 } from "openapi3-ts/oas31";
import { ZodError, ZodType, z } from "zod";
//#region src/index.d.ts
type MaybePromise<T> = Promise<T> | T;
type RouteConfig = RouteConfig$1 & {
  middleware?: H | H[];
  hide?: boolean;
};
type RequestTypes = {
  body?: ZodRequestBody;
  params?: ZodType;
  query?: ZodType;
  cookies?: ZodType;
  headers?: ZodType | ZodType[];
};
type IsJson<T> = T extends string ? T extends `application/${infer Start}json${infer _End}` ? Start extends "" | `${string}+` | `vnd.${string}+` ? "json" : never : never : never;
type IsForm<T> = T extends string ? T extends `multipart/form-data${infer _Rest}` | `application/x-www-form-urlencoded${infer _Rest}` ? "form" : never : never;
type ReturnJsonOrTextOrResponse<ContentType, Content, Code extends StatusCode> = ContentType extends string ? ContentType extends `application/${infer Start}json${infer _End}` ? Start extends "" | `${string}+` | `vnd.${string}+` ? TypedResponse<JSONParsed<Content>, Code, "json"> : never : ContentType extends `text/plain${infer _Rest}` ? TypedResponse<Content, Code, "text"> : Response : never;
type RequestPart<R extends RouteConfig, Part extends string> = Part extends keyof R["request"] ? R["request"][Part] : {};
type HasUndefined<T> = undefined extends T ? true : false;
type InputTypeBase<R extends RouteConfig, Part extends string, Type extends keyof ValidationTargets> = R["request"] extends RequestTypes ? RequestPart<R, Part> extends (infer Schema extends ZodType) ? {
  in: { [K in Type]: HasUndefined<ValidationTargets[K]> extends true ? { [K2 in keyof z.input<Schema>]?: z.input<Schema>[K2]; } : { [K2 in keyof z.input<Schema>]: z.input<Schema>[K2]; }; };
  out: { [K in Type]: z.output<Schema>; };
} : {} : {};
type InputTypeJson<R extends RouteConfig> = R["request"] extends RequestTypes ? R["request"]["body"] extends ZodRequestBody ? R["request"]["body"]["content"] extends (infer Content extends ZodContentObject) ? IsJson<keyof Content> extends never ? {} : Content[keyof Content] extends Record<"schema", infer Schema extends ZodType<any>> ? {
  in: {
    json: z.input<Schema>;
  };
  out: {
    json: z.output<Schema>;
  };
} : {} : {} : {} : {};
type InputTypeForm<R extends RouteConfig> = R["request"] extends RequestTypes ? R["request"]["body"] extends ZodRequestBody ? R["request"]["body"]["content"] extends (infer Content extends ZodContentObject) ? IsForm<keyof Content> extends never ? {} : Content[keyof Content] extends Record<"schema", infer Schema extends ZodType<any>> ? {
  in: {
    form: z.input<Schema>;
  };
  out: {
    form: z.output<Schema>;
  };
} : {} : {} : {} : {};
type InputTypeParam<R extends RouteConfig> = InputTypeBase<R, "params", "param">;
type InputTypeQuery<R extends RouteConfig> = InputTypeBase<R, "query", "query">;
type InputTypeHeader<R extends RouteConfig> = InputTypeBase<R, "headers", "header">;
type InputTypeCookie<R extends RouteConfig> = InputTypeBase<R, "cookies", "cookie">;
type ExtractContent<T> = T extends { [K in keyof T]: infer A; } ? A extends Record<"schema", infer Schema extends ZodType> ? z.infer<Schema> : never : never;
type StatusCodeRangeDefinitions = {
  "1XX": InfoStatusCode;
  "2XX": SuccessStatusCode;
  "3XX": RedirectStatusCode;
  "4XX": ClientErrorStatusCode;
  "5XX": ServerErrorStatusCode;
};
type RouteConfigStatusCode = keyof StatusCodeRangeDefinitions | StatusCode;
type ExtractStatusCode<T extends RouteConfigStatusCode> = T extends keyof StatusCodeRangeDefinitions ? StatusCodeRangeDefinitions[T] : T;
type DefinedStatusCodes<R extends RouteConfig> = keyof R["responses"] & RouteConfigStatusCode;
type RouteConfigToTypedResponse<R extends RouteConfig> = { [Status in DefinedStatusCodes<R>]: ExtractStatusCode<Status> extends (infer Code extends StatusCode) ? R["responses"][Status] extends {
  content: infer Content;
} ? undefined extends Content ? never : ReturnJsonOrTextOrResponse<keyof Content, ExtractContent<Content>, Code> : TypedResponse<{}, Code, string> : never; }[DefinedStatusCodes<R>] | ("default" extends keyof R["responses"] ? Exclude<StatusCode, ExtractStatusCode<DefinedStatusCodes<R>>> extends (infer Code extends StatusCode) ? R["responses"]["default"] extends {
  content: infer Content;
} ? undefined extends Content ? never : ReturnJsonOrTextOrResponse<keyof Content, ExtractContent<Content>, Code> : TypedResponse<{}, Code, string> : never : never);
type RouteHandlerResponse<R extends RouteConfig> = R extends {
  responses: {
    [statusCode: number]: {
      content: {
        [mediaType: string]: ZodMediaTypeObject;
      };
    };
  };
} ? MaybePromise<RouteConfigToTypedResponse<R>> : MaybePromise<RouteConfigToTypedResponse<R>> | MaybePromise<Response>;
type BoundRouteResponseTypes<R extends RouteConfig> = R extends RouteConfig ? [RouteConfigToTypedResponse<R>] extends [infer Output] ? {
  output: Output;
  handler: R extends {
    responses: {
      [statusCode: number]: {
        content: {
          [mediaType: string]: ZodMediaTypeObject;
        };
      };
    };
  } ? MaybePromise<Output> : MaybePromise<Output> | MaybePromise<Response>;
} : never : never;
type Hook<T, E extends Env, P extends string, R> = (result: {
  target: keyof ValidationTargets;
} & ({
  success: true;
  data: T;
} | {
  success: false;
  error: ZodError;
}), c: Context<E, P>) => R;
type ConvertPathType<T extends string> = T extends `${infer Start}/{${infer Param}}${infer Rest}` ? `${Start}/:${Param}${ConvertPathType<Rest>}` : T;
type OpenAPIHonoOptions<E extends Env> = {
  defaultHook?: Hook<any, E, any, any>;
};
type HonoInit<E extends Env> = ConstructorParameters<typeof Hono>[0] & OpenAPIHonoOptions<E>;
/**
 * Turns `T | T[] | undefined` into `T[]`
 */
type AsArray<T> = T extends undefined ? [] : T extends any[] ? T : [T];
/**
 * Like simplify but recursive
 */
type DeepSimplify<T> = { [KeyType in keyof T]: T[KeyType] extends Record<string, unknown> ? DeepSimplify<T[KeyType]> : T[KeyType]; } & {};
/**
 * Helper to infer generics from {@link MiddlewareHandler}
 */
type OfHandlerType<T extends MiddlewareHandler> = T extends MiddlewareHandler<infer E, infer P, infer I> ? {
  env: E;
  path: P;
  input: I;
} : never;
/**
 * Reduce a tuple of middleware handlers into a single
 * handler representing the composition of all
 * handlers.
 */
type MiddlewareToHandlerType<M extends MiddlewareHandler<any, any, any>[]> = M extends [infer First, infer Second, ...infer Rest] ? First extends MiddlewareHandler<any, any, any> ? Second extends MiddlewareHandler<any, any, any> ? Rest extends MiddlewareHandler<any, any, any>[] ? MiddlewareToHandlerType<[MiddlewareHandler<DeepSimplify<OfHandlerType<First>["env"] & OfHandlerType<Second>["env"]>, OfHandlerType<First>["path"], OfHandlerType<First>["input"]>, ...Rest]> : never : never : never : M extends [infer Last] ? Last : MiddlewareHandler<Env>;
type RouteMiddlewareParams<R extends RouteConfig> = OfHandlerType<MiddlewareToHandlerType<AsArray<R["middleware"]>>>;
type RouteConfigToEnv<R extends RouteConfig> = RouteMiddlewareParams<R> extends never ? Env : RouteMiddlewareParams<R>["env"];
type RouteHandler<R extends RouteConfig, E extends Env = RouteConfigToEnv<R>, I extends Input = ComputeInput<R>, P extends string = ConvertPathType<R["path"]>> = Handler<E, P, I, RouteHandlerResponse<R>>;
type RouteHook<R extends RouteConfig, E extends Env = RouteConfigToEnv<R>, I extends Input = ComputeInput<R>, P extends string = ConvertPathType<R["path"]>> = Hook<I, E, P, RouteConfigToTypedResponse<R> | Response | Promise<Response> | void | Promise<void>>;
type OpenAPIObjectConfig = Parameters<InstanceType<typeof OpenApiGeneratorV3>["generateDocument"]>[0];
type OpenAPIObjectConfigure<E extends Env, P extends string> = OpenAPIObjectConfig | ((context: Context<E, P>) => OpenAPIObjectConfig);
type OpenAPIGeneratorOptions = ConstructorParameters<typeof OpenApiGeneratorV3>[1];
type OpenAPIGeneratorConfigure<E extends Env, P extends string> = OpenAPIGeneratorOptions | ((context: Context<E, P>) => OpenAPIGeneratorOptions);
/**
 * Utility type to convert Hono types to OpenAPIHono types.
 * Replaces Hono return types with OpenAPIHono in function signatures.
 *
 * @example
 * ```ts
 * type MyOpenAPIHono = HonoToOpenAPIHono<Hono<Env>>
 * ```
 */
type HonoToOpenAPIHono<T> = T extends Hono<infer E, infer S, infer B> ? OpenAPIHono<E, S, B> : T;
/**
 * Converts a Hono instance to OpenAPIHono type.
 * Use this function to restore the OpenAPIHono type after chaining methods like `get`, `post`, `use`, etc.
 * @example
 * ```ts
 * import { OpenAPIHono, $ } from '@hono/zod-openapi'
 *
 * const app = $(
 *   new OpenAPIHono().use(middleware)
 * )
 * app.openapi(route, handler)
 * ```
 */
declare const $: <T extends Hono<any, any, any>>(app: T) => HonoToOpenAPIHono<T>;
type ComputeInput<R extends RouteConfig> = InputTypeParam<R> & InputTypeQuery<R> & InputTypeHeader<R> & InputTypeCookie<R> & InputTypeForm<R> & InputTypeJson<R>;
type HandlerFromRoute<R extends RouteConfig, E extends Env> = Handler<R["middleware"] extends MiddlewareHandler[] | MiddlewareHandler ? RouteMiddlewareParams<R>["env"] & E : E, ConvertPathType<R["path"]>, ComputeInput<R>, RouteHandlerResponse<R>>;
type HookFromRoute<R extends RouteConfig, E extends Env> = Hook<ComputeInput<R>, E, ConvertPathType<R["path"]>, RouteHandlerResponse<R> | undefined> | undefined;
type SchemaFromRoute<Entry, BasePath extends string> = Entry extends {
  route: infer R extends RouteConfig;
  addRoute?: infer AddRoute;
} ? [AddRoute] extends [false] ? {} : ToSchema<R["method"], MergePath<BasePath, ConvertPathType<R["path"]>>, ComputeInput<R>, RouteConfigToTypedResponse<R>> : {};
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends ((value: infer Intersection) => void) ? Intersection : never;
type NormalizeSchema<S> = { [Path in keyof S]: S[Path]; };
type SchemaFromRoutes<Routes extends readonly {
  route: RouteConfig;
  addRoute?: boolean;
}[], BasePath extends string> = number extends Routes["length"] ? {} : Routes extends readonly [] ? {} : NormalizeSchema<UnionToIntersection<SchemaFromRoute<Routes[number], BasePath>>>;
type OpenAPIRoute<R extends RouteConfig = RouteConfig, E extends Env = Env, AddRoute extends boolean | undefined = boolean | undefined> = {
  route: R;
  handler: HandlerFromRoute<R, E>;
  hook?: HookFromRoute<R, E>;
  addRoute?: AddRoute;
};
declare const defineOpenAPIRoute: <R extends RouteConfig, E extends Env = Env, const AddRoute extends boolean | undefined = undefined>(def: OpenAPIRoute<R, E, AddRoute>) => OpenAPIRoute<R, E, AddRoute>;
declare class OpenAPIHono<E extends Env = Env, S extends Schema = {}, BasePath extends string = "/"> extends Hono<E, S, BasePath> {
  #private;
  openAPIRegistry: OpenAPIRegistry;
  defaultHook?: OpenAPIHonoOptions<E>["defaultHook"];
  constructor(init?: HonoInit<E>);
  /**
   *
   * @param {RouteConfig} route - The route definition which you create with `createRoute()`.
   * @param {Handler} handler - The handler. If you want to return a JSON object, you should specify the status code with `c.json()`.
   * @param {Hook} hook - Optional. The hook method defines what it should do after validation.
   * @example
   * app.openapi(
   *   route,
   *   (c) => {
   *     // ...
   *     return c.json(
   *       {
   *         age: 20,
   *         name: 'Young man',
   *       },
   *       200 // You should specify the status code even if it's 200.
   *     )
   *   },
   *  (result, c) => {
   *    if (!result.success) {
   *      return c.json(
   *        {
   *          code: 400,
   *          message: 'Custom Message',
   *        },
   *        400
   *      )
   *    }
   *  }
   *)
   */
  openapi: <R extends RouteConfig, I extends Input = ComputeInput<R>, P extends string = ConvertPathType<R["path"]>>({ middleware: routeMiddleware, hide, ...route }: R, handler: Handler<R["middleware"] extends MiddlewareHandler[] | MiddlewareHandler ? RouteMiddlewareParams<R>["env"] & E : E, P, I, BoundRouteResponseTypes<R>["handler"]>, hook?: Hook<I, E, P, BoundRouteResponseTypes<R>["handler"] | undefined> | undefined) => OpenAPIHono<E, S & ToSchema<R["method"], MergePath<BasePath, P>, I, BoundRouteResponseTypes<R>["output"]>, BasePath>;
  /**
   * Register a list of routes with full Type Safety and RPC support.
   * * @param inputs - An array of objects containing { route, handler, hook }.
   * Must be defined `as const` or inline to preserve tuple types.
   */
  openapiRoutes: <const Inputs extends readonly {
    route: RouteConfig;
    handler: any;
    hook?: any;
    addRoute?: boolean;
  }[]>(inputs: Inputs) => OpenAPIHono<E, S & SchemaFromRoutes<Inputs, BasePath>, BasePath>;
  getOpenAPIDocument: (objectConfig: OpenAPIObjectConfig, generatorConfig?: OpenAPIGeneratorOptions) => OpenAPIObject;
  getOpenAPI31Document: (objectConfig: OpenAPIObjectConfig, generatorConfig?: OpenAPIGeneratorOptions) => OpenAPIObject$1;
  doc: <P extends string>(path: P, configureObject: OpenAPIObjectConfigure<E, P>, configureGenerator?: OpenAPIGeneratorConfigure<E, P>) => OpenAPIHono<E, S & ToSchema<"get", MergePath<BasePath, P>, {}, {}>, BasePath>;
  doc31: <P extends string>(path: P, configureObject: OpenAPIObjectConfigure<E, P>, configureGenerator?: OpenAPIGeneratorConfigure<E, P>) => OpenAPIHono<E, S & ToSchema<"get", MergePath<BasePath, P>, {}, {}>, BasePath>;
  override route<SubPath extends string, SubEnv extends Env, SubSchema extends Schema, SubBasePath extends string>(path: SubPath, app: Hono<SubEnv, SubSchema, SubBasePath>): OpenAPIHono<E, MergeSchemaPath<SubSchema, MergePath<BasePath, SubPath>> & S, BasePath>;
  override route<SubPath extends string>(path: SubPath): Hono<E, RemoveBlankRecord<S>, BasePath>;
  override basePath<SubPath extends string>(path: SubPath): OpenAPIHono<E, S, MergePath<BasePath, SubPath>>;
  onError: (handler: ErrorHandler<E>) => OpenAPIHono<E, S, BasePath>;
  notFound: (handler: NotFoundHandler<E>) => OpenAPIHono<E, S, BasePath>;
}
declare const createRoute: <P extends string, R extends Omit<RouteConfig, "path"> & {
  path: P;
}>(routeConfig: R) => R & {
  getRoutingPath(): ConvertPathType<R["path"]>;
};
//#endregion
export { $, DeepSimplify, HonoToOpenAPIHono, Hook, MiddlewareToHandlerType, OfHandlerType, OpenAPIGeneratorConfigure, OpenAPIGeneratorOptions, OpenAPIHono, OpenAPIHonoOptions, OpenAPIObjectConfigure, OpenAPIRoute, RouteConfig, RouteConfigToEnv, RouteConfigToTypedResponse, RouteHandler, RouteHook, createRoute, defineOpenAPIRoute, extendZodWithOpenApi, z };
//# sourceMappingURL=index.d.cts.map