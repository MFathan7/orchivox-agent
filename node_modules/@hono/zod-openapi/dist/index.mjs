import { OpenAPIRegistry, OpenApiGeneratorV3, OpenApiGeneratorV31, extendZodWithOpenApi, getOpenApiMetadata } from "@asteasolutions/zod-to-openapi";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { mergePath } from "hono/utils/url";
import { z } from "zod";
//#region src/zod-typeguard.ts
function isObject(x) {
	return typeof x === "object" && x !== null;
}
function isZod(x) {
	if (!x) return false;
	if (!isObject(x)) return false;
	return typeof x.parse === "function" && typeof x.safeParse === "function" && typeof x.parseAsync === "function" && typeof x.safeParseAsync === "function";
}
//#endregion
//#region src/index.ts
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
const $ = (app) => {
	return app;
};
const defineOpenAPIRoute = (def) => {
	return def;
};
var OpenAPIHono = class OpenAPIHono extends Hono {
	openAPIRegistry;
	defaultHook;
	#parentApp;
	constructor(init) {
		super(init);
		this.openAPIRegistry = new OpenAPIRegistry();
		this.defaultHook = init === null || init === void 0 ? void 0 : init.defaultHook;
	}
	#resolveDefaultHook() {
		if (this.defaultHook) return this.defaultHook;
		const seen = /* @__PURE__ */ new Set([this]);
		let parent = this.#parentApp;
		while (parent && !seen.has(parent)) {
			if (parent.defaultHook) return parent.defaultHook;
			seen.add(parent);
			parent = parent.#parentApp;
		}
	}
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
	openapi = ({ middleware: routeMiddleware, hide, ...route }, handler, hook = void 0) => {
		var _route$request, _route$request2, _route$request3, _route$request4, _route$request5;
		if (!hide) this.openAPIRegistry.registerPath(route);
		const effectiveHook = hook ?? ((result, c) => {
			const resolved = this.#resolveDefaultHook();
			return resolved ? resolved(result, c) : void 0;
		});
		const validators = [];
		if ((_route$request = route.request) === null || _route$request === void 0 ? void 0 : _route$request.query) {
			const validator = zValidator("query", route.request.query, effectiveHook);
			validators.push(validator);
		}
		if ((_route$request2 = route.request) === null || _route$request2 === void 0 ? void 0 : _route$request2.params) {
			const validator = zValidator("param", route.request.params, effectiveHook);
			validators.push(validator);
		}
		if ((_route$request3 = route.request) === null || _route$request3 === void 0 ? void 0 : _route$request3.headers) {
			const validator = zValidator("header", route.request.headers, effectiveHook);
			validators.push(validator);
		}
		if ((_route$request4 = route.request) === null || _route$request4 === void 0 ? void 0 : _route$request4.cookies) {
			const validator = zValidator("cookie", route.request.cookies, effectiveHook);
			validators.push(validator);
		}
		const bodyContent = (_route$request5 = route.request) === null || _route$request5 === void 0 || (_route$request5 = _route$request5.body) === null || _route$request5 === void 0 ? void 0 : _route$request5.content;
		if (bodyContent) {
			const declaredMediaTypes = Object.keys(bodyContent);
			if (declaredMediaTypes.some((mediaType) => {
				var _bodyContent$mediaTyp;
				return isZod((_bodyContent$mediaTyp = bodyContent[mediaType]) === null || _bodyContent$mediaTyp === void 0 ? void 0 : _bodyContent$mediaTyp.schema) && (isJSONContentType(mediaType) || isFormContentType(mediaType));
			})) {
				const mediaTypeGate = async (c, next) => {
					const contentType = c.req.header("content-type");
					if (contentType) {
						if (!declaredMediaTypes.some((mediaType) => matchesMediaType(contentType, mediaType))) throw new HTTPException(415, { message: "Unsupported Media Type" });
					} else if (await hasRequestBody(c)) throw new HTTPException(415, { message: "Unsupported Media Type" });
					await next();
				};
				validators.push(mediaTypeGate);
			}
			for (const mediaType of declaredMediaTypes) {
				if (!bodyContent[mediaType]) continue;
				const schema = bodyContent[mediaType]["schema"];
				if (!isZod(schema)) continue;
				if (isJSONContentType(mediaType)) {
					var _route$request6;
					const validator = zValidator("json", schema, effectiveHook);
					if ((_route$request6 = route.request) === null || _route$request6 === void 0 || (_route$request6 = _route$request6.body) === null || _route$request6 === void 0 ? void 0 : _route$request6.required) validators.push(validator);
					else {
						const mw = async (c, next) => {
							if (c.req.header("content-type")) {
								if (isJSONContentType(c.req.header("content-type"))) return await validator(c, next);
							}
							c.req.addValidatedData("json", {});
							await next();
						};
						validators.push(mw);
					}
				}
				if (isFormContentType(mediaType)) {
					var _route$request7;
					const validator = zValidator("form", schema, effectiveHook);
					if ((_route$request7 = route.request) === null || _route$request7 === void 0 || (_route$request7 = _route$request7.body) === null || _route$request7 === void 0 ? void 0 : _route$request7.required) validators.push(validator);
					else {
						const mw = async (c, next) => {
							if (c.req.header("content-type")) {
								if (isFormContentType(c.req.header("content-type"))) return await validator(c, next);
							}
							c.req.addValidatedData("form", {});
							await next();
						};
						validators.push(mw);
					}
				}
			}
		}
		const middleware = routeMiddleware ? Array.isArray(routeMiddleware) ? routeMiddleware : [routeMiddleware] : [];
		this.on([route.method], [route.path.replaceAll(/\/{(.+?)}/g, "/:$1")], ...middleware, ...validators, handler);
		return this;
	};
	/**
	* Register a list of routes with full Type Safety and RPC support.
	* * @param inputs - An array of objects containing { route, handler, hook }.
	* Must be defined `as const` or inline to preserve tuple types.
	*/
	openapiRoutes = (inputs) => {
		inputs.filter(({ addRoute }) => addRoute !== false).forEach(({ route, handler, hook }) => {
			this.openapi(route, handler, hook);
		});
		return this;
	};
	getOpenAPIDocument = (objectConfig, generatorConfig) => {
		const document = new OpenApiGeneratorV3(this.openAPIRegistry.definitions, generatorConfig).generateDocument(objectConfig);
		return this._basePath ? addBasePathToDocument(document, this._basePath) : document;
	};
	getOpenAPI31Document = (objectConfig, generatorConfig) => {
		const document = new OpenApiGeneratorV31(this.openAPIRegistry.definitions, generatorConfig).generateDocument(objectConfig);
		return this._basePath ? addBasePathToDocument(document, this._basePath) : document;
	};
	doc = (path, configureObject, configureGenerator) => {
		return this.get(path, (c) => {
			const objectConfig = typeof configureObject === "function" ? configureObject(c) : configureObject;
			const generatorConfig = typeof configureGenerator === "function" ? configureGenerator(c) : configureGenerator;
			try {
				const document = this.getOpenAPIDocument(objectConfig, generatorConfig);
				return c.json(document);
			} catch (e) {
				return c.json(e, 500);
			}
		});
	};
	doc31 = (path, configureObject, configureGenerator) => {
		return this.get(path, (c) => {
			const objectConfig = typeof configureObject === "function" ? configureObject(c) : configureObject;
			const generatorConfig = typeof configureGenerator === "function" ? configureGenerator(c) : configureGenerator;
			try {
				const document = this.getOpenAPI31Document(objectConfig, generatorConfig);
				return c.json(document);
			} catch (e) {
				return c.json(e, 500);
			}
		});
	};
	route(path, app) {
		const pathForOpenAPI = path.replaceAll(/:([^\/]+)/g, "{$1}");
		super.route(path, app);
		if (!(app instanceof OpenAPIHono)) return this;
		app.#parentApp ??= this;
		app.openAPIRegistry.definitions.forEach((def) => {
			switch (def.type) {
				case "component": return this.openAPIRegistry.registerComponent(def.componentType, def.name, def.component);
				case "route":
					this.openAPIRegistry.registerPath({
						...def.route,
						path: mergePath(pathForOpenAPI, app._basePath.replaceAll(/:([^\/]+)/g, "{$1}"), def.route.path)
					});
					return;
				case "webhook":
					this.openAPIRegistry.registerWebhook({
						...def.webhook,
						path: mergePath(pathForOpenAPI, app._basePath.replaceAll(/:([^\/]+)/g, "{$1}"), def.webhook.path)
					});
					return;
				case "schema":
					var _getOpenApiMetadata$_;
					return this.openAPIRegistry.register((_getOpenApiMetadata$_ = getOpenApiMetadata(def.schema)._internal) === null || _getOpenApiMetadata$_ === void 0 ? void 0 : _getOpenApiMetadata$_.refId, def.schema);
				case "parameter":
					var _getOpenApiMetadata$_2;
					return this.openAPIRegistry.registerParameter((_getOpenApiMetadata$_2 = getOpenApiMetadata(def.schema)._internal) === null || _getOpenApiMetadata$_2 === void 0 ? void 0 : _getOpenApiMetadata$_2.refId, def.schema);
				default: throw new Error(`Unknown registry type: ${def}`);
			}
		});
		return this;
	}
	basePath(path) {
		const cloned = super.basePath(path);
		const newApp = new OpenAPIHono({ defaultHook: this.defaultHook });
		newApp.router = cloned.router;
		newApp.routes = cloned.routes;
		const { getPath } = cloned;
		const clonedInternal = cloned;
		Object.assign(newApp, {
			getPath,
			errorHandler: clonedInternal.errorHandler,
			_basePath: clonedInternal._basePath
		});
		return newApp;
	}
};
const createRoute = (routeConfig) => {
	const route = {
		...routeConfig,
		getRoutingPath() {
			return routeConfig.path.replaceAll(/\/{(.+?)}/g, "/:$1");
		}
	};
	return Object.defineProperty(route, "getRoutingPath", { enumerable: false });
};
extendZodWithOpenApi(z);
function addBasePathToDocument(document, basePath) {
	const updatedPaths = {};
	Object.keys(document.paths).forEach((path) => {
		updatedPaths[mergePath(basePath.replaceAll(/:([^\/]+)/g, "{$1}"), path)] = document.paths[path];
	});
	return {
		...document,
		paths: updatedPaths
	};
}
function isJSONContentType(contentType) {
	return /^application\/([a-z-\.]+\+)?json/i.test(contentType);
}
const jsonRequestRegex = /^application\/([a-z-\.]+\+)?json(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/i;
const multipartRequestRegex = /^multipart\/form-data(;\s?boundary=[a-zA-Z0-9'"()+_,\-./:=?]+)?$/i;
const urlencodedRequestRegex = /^application\/x-www-form-urlencoded(;\s*[a-zA-Z0-9\-]+\=([^;]+))*$/i;
function matchesMediaType(contentType, mediaType) {
	if (mediaType === "*/*") return true;
	if (isJSONContentType(mediaType)) return jsonRequestRegex.test(contentType);
	if (isFormContentType(mediaType)) return multipartRequestRegex.test(contentType) || urlencodedRequestRegex.test(contentType);
	const essence = contentType.split(";")[0].trim().toLowerCase();
	if (mediaType.endsWith("/*")) return essence.startsWith(mediaType.slice(0, -1).toLowerCase());
	return essence === mediaType.toLowerCase();
}
async function hasRequestBody(c) {
	const raw = c.req.raw;
	if (raw.body === null) return false;
	if (raw.bodyUsed) return (await c.req.arrayBuffer()).byteLength > 0;
	const body = raw.clone().body;
	if (body === null) return false;
	const reader = body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (value.byteLength > 0) return true;
		}
	} finally {
		reader.cancel().catch(() => {});
	}
}
function isFormContentType(contentType) {
	const lower = contentType.toLowerCase();
	return lower.startsWith("multipart/form-data") || lower.startsWith("application/x-www-form-urlencoded");
}
//#endregion
export { $, OpenAPIHono, createRoute, defineOpenAPIRoute, extendZodWithOpenApi, z };

//# sourceMappingURL=index.mjs.map