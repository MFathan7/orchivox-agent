import { type ZodType, z } from 'zod';
import type { AuthenticationConfiguration } from './authentication-configuration.js';
import { type SourceConfiguration } from './source-configuration.js';
import type { ApiReferenceLocalization } from './types.js';
/**
 * Standard configuration for the Api Reference.
 *
 * This is used internally to the configure the applications and does not include the sources.
 *
 * Sources should only be specified in the user facing configurations.
 *
 * In the the future it is likely sources will be removed completely from the configuration and instead
 * specified through a separate addDocument interface.
 */
export declare const apiReferenceConfigurationSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
    authentication: z.ZodOptional<z.ZodAny>;
    baseServerURL: z.ZodOptional<z.ZodString>;
    hideClientButton: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    proxyUrl: z.ZodOptional<z.ZodString>;
    oauth2RedirectUri: z.ZodOptional<z.ZodString>;
    searchHotKey: z.ZodOptional<z.ZodEnum<{
        a: "a";
        b: "b";
        c: "c";
        d: "d";
        e: "e";
        f: "f";
        g: "g";
        h: "h";
        i: "i";
        j: "j";
        k: "k";
        l: "l";
        m: "m";
        n: "n";
        o: "o";
        p: "p";
        q: "q";
        r: "r";
        s: "s";
        t: "t";
        u: "u";
        v: "v";
        w: "w";
        x: "x";
        y: "y";
        z: "z";
    }>>;
    servers: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    showSidebar: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    showDeveloperTools: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        never: "never";
        always: "always";
        localhost: "localhost";
    }>>>>;
    showToolbar: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        never: "never";
        always: "always";
        localhost: "localhost";
    }>>>>;
    operationTitleSource: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        summary: "summary";
        path: "path";
    }>>>>;
    theme: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        default: "default";
        alternate: "alternate";
        moon: "moon";
        purple: "purple";
        solarized: "solarized";
        bluePlanet: "bluePlanet";
        deepSpace: "deepSpace";
        saturn: "saturn";
        kepler: "kepler";
        elysiajs: "elysiajs";
        fastify: "fastify";
        mars: "mars";
        laserwave: "laserwave";
        none: "none";
    }>>>>;
    _integration: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        elysiajs: "elysiajs";
        fastify: "fastify";
        adonisjs: "adonisjs";
        astro: "astro";
        docusaurus: "docusaurus";
        dotnet: "dotnet";
        express: "express";
        fastapi: "fastapi";
        go: "go";
        hono: "hono";
        html: "html";
        laravel: "laravel";
        litestar: "litestar";
        nestjs: "nestjs";
        nextjs: "nextjs";
        nitro: "nitro";
        nuxt: "nuxt";
        platformatic: "platformatic";
        react: "react";
        rust: "rust";
        svelte: "svelte";
        vue: "vue";
    }>>>;
    onRequestSent: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>;
    persistAuth: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    telemetry: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    externalUrls: z.ZodPrefault<z.ZodObject<{
        dashboardUrl: z.ZodPrefault<z.ZodString>;
        registryUrl: z.ZodPrefault<z.ZodString>;
        proxyUrl: z.ZodPrefault<z.ZodString>;
        apiBaseUrl: z.ZodPrefault<z.ZodString>;
    }, z.core.$strip>>;
    layout: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        modern: "modern";
        classic: "classic";
    }>>>>;
    proxy: z.ZodOptional<z.ZodString>;
    fetch: z.ZodOptional<z.ZodCustom<(input: string | URL | Request, init?: RequestInit) => Promise<Response>, (input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
    customFetch: z.ZodOptional<z.ZodCustom<(input: string | URL | Request, init?: RequestInit) => Promise<Response>, (input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
    plugins: z.ZodOptional<z.ZodArray<z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
        name: z.ZodString;
        extensions: z.ZodArray<z.ZodObject<{
            name: z.ZodString;
            component: z.ZodUnknown;
            renderer: z.ZodOptional<z.ZodUnknown>;
        }, z.core.$strip>>;
        views: z.ZodOptional<z.ZodObject<{
            'content.start': z.ZodOptional<z.ZodArray<z.ZodObject<{
                component: z.ZodUnknown;
                renderer: z.ZodOptional<z.ZodUnknown>;
                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                sidebar: z.ZodOptional<z.ZodObject<{
                    show: z.ZodDefault<z.ZodBoolean>;
                    label: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
            'content.end': z.ZodOptional<z.ZodArray<z.ZodObject<{
                component: z.ZodUnknown;
                renderer: z.ZodOptional<z.ZodUnknown>;
                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                sidebar: z.ZodOptional<z.ZodObject<{
                    show: z.ZodDefault<z.ZodBoolean>;
                    label: z.ZodString;
                }, z.core.$strip>>;
            }, z.core.$strip>>>;
        }, z.core.$strip>>;
        markdown: z.ZodOptional<z.ZodCustom<import("@scalar/helpers/markdown/markdown-render-hook").MarkdownRenderHook, import("@scalar/helpers/markdown/markdown-render-hook").MarkdownRenderHook>>;
        hooks: z.ZodOptional<z.ZodObject<{
            onInit: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                config: z.ZodObject<{
                    title: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    slug: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    authentication: z.ZodOptional<z.ZodOptional<z.ZodAny>>;
                    baseServerURL: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    hideClientButton: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    proxyUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    oauth2RedirectUri: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    searchHotKey: z.ZodOptional<z.ZodOptional<z.ZodEnum<{
                        a: "a";
                        b: "b";
                        c: "c";
                        d: "d";
                        e: "e";
                        f: "f";
                        g: "g";
                        h: "h";
                        i: "i";
                        j: "j";
                        k: "k";
                        l: "l";
                        m: "m";
                        n: "n";
                        o: "o";
                        p: "p";
                        q: "q";
                        r: "r";
                        s: "s";
                        t: "t";
                        u: "u";
                        v: "v";
                        w: "w";
                        x: "x";
                        y: "y";
                        z: "z";
                    }>>>;
                    servers: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodAny>>>;
                    showSidebar: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    showDeveloperTools: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        never: "never";
                        always: "always";
                        localhost: "localhost";
                    }>>>>>;
                    showToolbar: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        never: "never";
                        always: "always";
                        localhost: "localhost";
                    }>>>>>;
                    operationTitleSource: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        summary: "summary";
                        path: "path";
                    }>>>>>;
                    theme: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        default: "default";
                        alternate: "alternate";
                        moon: "moon";
                        purple: "purple";
                        solarized: "solarized";
                        bluePlanet: "bluePlanet";
                        deepSpace: "deepSpace";
                        saturn: "saturn";
                        kepler: "kepler";
                        elysiajs: "elysiajs";
                        fastify: "fastify";
                        mars: "mars";
                        laserwave: "laserwave";
                        none: "none";
                    }>>>>>;
                    _integration: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodEnum<{
                        elysiajs: "elysiajs";
                        fastify: "fastify";
                        adonisjs: "adonisjs";
                        astro: "astro";
                        docusaurus: "docusaurus";
                        dotnet: "dotnet";
                        express: "express";
                        fastapi: "fastapi";
                        go: "go";
                        hono: "hono";
                        html: "html";
                        laravel: "laravel";
                        litestar: "litestar";
                        nestjs: "nestjs";
                        nextjs: "nextjs";
                        nitro: "nitro";
                        nuxt: "nuxt";
                        platformatic: "platformatic";
                        react: "react";
                        rust: "rust";
                        svelte: "svelte";
                        vue: "vue";
                    }>>>>;
                    onRequestSent: z.ZodOptional<z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>>;
                    persistAuth: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    plugins: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
                        name: z.ZodString;
                        views: z.ZodOptional<z.ZodObject<{
                            'request.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
                                title: z.ZodOptional<z.ZodString>;
                                component: z.ZodUnknown;
                                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                            }, z.core.$strip>>>;
                            'response.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
                                title: z.ZodOptional<z.ZodString>;
                                component: z.ZodUnknown;
                                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                            }, z.core.$strip>>>;
                        }, z.core.$strip>>;
                        hooks: z.ZodOptional<z.ZodObject<{
                            onBeforeRequest: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                                request: z.ZodAny;
                            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
                            onResponseReceived: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                                response: z.ZodCustom<Response, Response>;
                                operation: z.ZodRecord<z.ZodString, z.ZodAny>;
                            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>>>>;
                    telemetry: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
                    externalUrls: z.ZodOptional<z.ZodPrefault<z.ZodObject<{
                        dashboardUrl: z.ZodPrefault<z.ZodString>;
                        registryUrl: z.ZodPrefault<z.ZodString>;
                        proxyUrl: z.ZodPrefault<z.ZodString>;
                        apiBaseUrl: z.ZodPrefault<z.ZodString>;
                    }, z.core.$strip>>>;
                }, z.core.$strip>;
                auth: z.ZodCustom<import("./api-reference-plugin.js").PluginAuthState, import("./api-reference-plugin.js").PluginAuthState>;
            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
            onConfigChange: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                config: z.ZodObject<{
                    title: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    slug: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    authentication: z.ZodOptional<z.ZodOptional<z.ZodAny>>;
                    baseServerURL: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    hideClientButton: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    proxyUrl: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    oauth2RedirectUri: z.ZodOptional<z.ZodOptional<z.ZodString>>;
                    searchHotKey: z.ZodOptional<z.ZodOptional<z.ZodEnum<{
                        a: "a";
                        b: "b";
                        c: "c";
                        d: "d";
                        e: "e";
                        f: "f";
                        g: "g";
                        h: "h";
                        i: "i";
                        j: "j";
                        k: "k";
                        l: "l";
                        m: "m";
                        n: "n";
                        o: "o";
                        p: "p";
                        q: "q";
                        r: "r";
                        s: "s";
                        t: "t";
                        u: "u";
                        v: "v";
                        w: "w";
                        x: "x";
                        y: "y";
                        z: "z";
                    }>>>;
                    servers: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodAny>>>;
                    showSidebar: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    showDeveloperTools: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        never: "never";
                        always: "always";
                        localhost: "localhost";
                    }>>>>>;
                    showToolbar: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        never: "never";
                        always: "always";
                        localhost: "localhost";
                    }>>>>>;
                    operationTitleSource: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        summary: "summary";
                        path: "path";
                    }>>>>>;
                    theme: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                        default: "default";
                        alternate: "alternate";
                        moon: "moon";
                        purple: "purple";
                        solarized: "solarized";
                        bluePlanet: "bluePlanet";
                        deepSpace: "deepSpace";
                        saturn: "saturn";
                        kepler: "kepler";
                        elysiajs: "elysiajs";
                        fastify: "fastify";
                        mars: "mars";
                        laserwave: "laserwave";
                        none: "none";
                    }>>>>>;
                    _integration: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodEnum<{
                        elysiajs: "elysiajs";
                        fastify: "fastify";
                        adonisjs: "adonisjs";
                        astro: "astro";
                        docusaurus: "docusaurus";
                        dotnet: "dotnet";
                        express: "express";
                        fastapi: "fastapi";
                        go: "go";
                        hono: "hono";
                        html: "html";
                        laravel: "laravel";
                        litestar: "litestar";
                        nestjs: "nestjs";
                        nextjs: "nextjs";
                        nitro: "nitro";
                        nuxt: "nuxt";
                        platformatic: "platformatic";
                        react: "react";
                        rust: "rust";
                        svelte: "svelte";
                        vue: "vue";
                    }>>>>;
                    onRequestSent: z.ZodOptional<z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>>;
                    persistAuth: z.ZodOptional<z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>>;
                    plugins: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
                        name: z.ZodString;
                        views: z.ZodOptional<z.ZodObject<{
                            'request.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
                                title: z.ZodOptional<z.ZodString>;
                                component: z.ZodUnknown;
                                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                            }, z.core.$strip>>>;
                            'response.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
                                title: z.ZodOptional<z.ZodString>;
                                component: z.ZodUnknown;
                                props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
                            }, z.core.$strip>>>;
                        }, z.core.$strip>>;
                        hooks: z.ZodOptional<z.ZodObject<{
                            onBeforeRequest: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                                request: z.ZodAny;
                            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
                            onResponseReceived: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
                                response: z.ZodCustom<Response, Response>;
                                operation: z.ZodRecord<z.ZodString, z.ZodAny>;
                            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
                        }, z.core.$strip>>;
                    }, z.core.$strip>>>>>;
                    telemetry: z.ZodOptional<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
                    externalUrls: z.ZodOptional<z.ZodPrefault<z.ZodObject<{
                        dashboardUrl: z.ZodPrefault<z.ZodString>;
                        registryUrl: z.ZodPrefault<z.ZodString>;
                        proxyUrl: z.ZodPrefault<z.ZodString>;
                        apiBaseUrl: z.ZodPrefault<z.ZodString>;
                    }, z.core.$strip>>>;
                }, z.core.$strip>;
                auth: z.ZodCustom<import("./api-reference-plugin.js").PluginAuthState, import("./api-reference-plugin.js").PluginAuthState>;
            }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
            onDestroy: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [], null>, z.core.$ZodFunctionOut>>;
        }, z.core.$strip>>;
        apiClientPlugins: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    }, z.core.$strip>>>>;
    pluginUrls: z.ZodOptional<z.ZodArray<z.ZodString>>;
    isEditable: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    hideModels: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    hideModelNames: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    modelsSectionLabel: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"Models">, z.ZodLiteral<"Schemas">, z.ZodString]>>>>;
    localization: ZodType<ApiReferenceLocalization | undefined, unknown, z.core.$ZodTypeInternals<ApiReferenceLocalization | undefined, unknown>>;
    documentDownloadType: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        none: "none";
        both: "both";
        yaml: "yaml";
        json: "json";
        direct: "direct";
    }>>>>;
    hideDownloadButton: z.ZodOptional<z.ZodBoolean>;
    hideTestRequestButton: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    hideSearch: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    showOperationId: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    showExtensions: z.ZodOptional<z.ZodArray<z.ZodString>>;
    darkMode: z.ZodOptional<z.ZodBoolean>;
    forceDarkModeState: z.ZodOptional<z.ZodEnum<{
        dark: "dark";
        light: "light";
    }>>;
    hideDarkModeToggle: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    metaData: z.ZodOptional<z.ZodAny>;
    favicon: z.ZodOptional<z.ZodString>;
    hiddenClients: z.ZodOptional<z.ZodUnion<readonly [z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodArray<z.ZodCustom<"laravel" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget", "laravel" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget">>]>>, z.ZodArray<z.ZodCustom<"c" | "r" | "go" | "laravel" | "rust" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "julia" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift" | "c/laravel" | "c/libcurl" | "c/clj_http" | "c/httpclient" | "c/restsharp" | "c/http" | "c/native" | "c/http1.1" | "c/asynchttp" | "c/nethttp" | "c/okhttp" | "c/unirest" | "c/axios" | "c/fetch" | "c/jquery" | "c/ofetch" | "c/xhr" | "c/undici" | "c/nsurlsession" | "c/cohttp" | "c/curl" | "c/guzzle" | "c/restmethod" | "c/webrequest" | "c/python3" | "c/requests" | "c/aiohttp" | "c/httpx_sync" | "c/httpx_async" | "c/httr2" | "c/reqwest" | "c/httpie" | "c/wget" | "r/laravel" | "r/libcurl" | "r/clj_http" | "r/httpclient" | "r/restsharp" | "r/http" | "r/native" | "r/http1.1" | "r/asynchttp" | "r/nethttp" | "r/okhttp" | "r/unirest" | "r/axios" | "r/fetch" | "r/jquery" | "r/ofetch" | "r/xhr" | "r/undici" | "r/nsurlsession" | "r/cohttp" | "r/curl" | "r/guzzle" | "r/restmethod" | "r/webrequest" | "r/python3" | "r/requests" | "r/aiohttp" | "r/httpx_sync" | "r/httpx_async" | "r/httr2" | "r/reqwest" | "r/httpie" | "r/wget" | "go/laravel" | "go/libcurl" | "go/clj_http" | "go/httpclient" | "go/restsharp" | "go/http" | "go/native" | "go/http1.1" | "go/asynchttp" | "go/nethttp" | "go/okhttp" | "go/unirest" | "go/axios" | "go/fetch" | "go/jquery" | "go/ofetch" | "go/xhr" | "go/undici" | "go/nsurlsession" | "go/cohttp" | "go/curl" | "go/guzzle" | "go/restmethod" | "go/webrequest" | "go/python3" | "go/requests" | "go/aiohttp" | "go/httpx_sync" | "go/httpx_async" | "go/httr2" | "go/reqwest" | "go/httpie" | "go/wget" | "rust/laravel" | "rust/libcurl" | "rust/clj_http" | "rust/httpclient" | "rust/restsharp" | "rust/http" | "rust/native" | "rust/http1.1" | "rust/asynchttp" | "rust/nethttp" | "rust/okhttp" | "rust/unirest" | "rust/axios" | "rust/fetch" | "rust/jquery" | "rust/ofetch" | "rust/xhr" | "rust/undici" | "rust/nsurlsession" | "rust/cohttp" | "rust/curl" | "rust/guzzle" | "rust/restmethod" | "rust/webrequest" | "rust/python3" | "rust/requests" | "rust/aiohttp" | "rust/httpx_sync" | "rust/httpx_async" | "rust/httr2" | "rust/reqwest" | "rust/httpie" | "rust/wget" | "http/laravel" | "http/libcurl" | "http/clj_http" | "http/httpclient" | "http/restsharp" | "http/http" | "http/native" | "http/http1.1" | "http/asynchttp" | "http/nethttp" | "http/okhttp" | "http/unirest" | "http/axios" | "http/fetch" | "http/jquery" | "http/ofetch" | "http/xhr" | "http/undici" | "http/nsurlsession" | "http/cohttp" | "http/curl" | "http/guzzle" | "http/restmethod" | "http/webrequest" | "http/python3" | "http/requests" | "http/aiohttp" | "http/httpx_sync" | "http/httpx_async" | "http/httr2" | "http/reqwest" | "http/httpie" | "http/wget" | "clojure/laravel" | "clojure/libcurl" | "clojure/clj_http" | "clojure/httpclient" | "clojure/restsharp" | "clojure/http" | "clojure/native" | "clojure/http1.1" | "clojure/asynchttp" | "clojure/nethttp" | "clojure/okhttp" | "clojure/unirest" | "clojure/axios" | "clojure/fetch" | "clojure/jquery" | "clojure/ofetch" | "clojure/xhr" | "clojure/undici" | "clojure/nsurlsession" | "clojure/cohttp" | "clojure/curl" | "clojure/guzzle" | "clojure/restmethod" | "clojure/webrequest" | "clojure/python3" | "clojure/requests" | "clojure/aiohttp" | "clojure/httpx_sync" | "clojure/httpx_async" | "clojure/httr2" | "clojure/reqwest" | "clojure/httpie" | "clojure/wget" | "csharp/laravel" | "csharp/libcurl" | "csharp/clj_http" | "csharp/httpclient" | "csharp/restsharp" | "csharp/http" | "csharp/native" | "csharp/http1.1" | "csharp/asynchttp" | "csharp/nethttp" | "csharp/okhttp" | "csharp/unirest" | "csharp/axios" | "csharp/fetch" | "csharp/jquery" | "csharp/ofetch" | "csharp/xhr" | "csharp/undici" | "csharp/nsurlsession" | "csharp/cohttp" | "csharp/curl" | "csharp/guzzle" | "csharp/restmethod" | "csharp/webrequest" | "csharp/python3" | "csharp/requests" | "csharp/aiohttp" | "csharp/httpx_sync" | "csharp/httpx_async" | "csharp/httr2" | "csharp/reqwest" | "csharp/httpie" | "csharp/wget" | "dart/laravel" | "dart/libcurl" | "dart/clj_http" | "dart/httpclient" | "dart/restsharp" | "dart/http" | "dart/native" | "dart/http1.1" | "dart/asynchttp" | "dart/nethttp" | "dart/okhttp" | "dart/unirest" | "dart/axios" | "dart/fetch" | "dart/jquery" | "dart/ofetch" | "dart/xhr" | "dart/undici" | "dart/nsurlsession" | "dart/cohttp" | "dart/curl" | "dart/guzzle" | "dart/restmethod" | "dart/webrequest" | "dart/python3" | "dart/requests" | "dart/aiohttp" | "dart/httpx_sync" | "dart/httpx_async" | "dart/httr2" | "dart/reqwest" | "dart/httpie" | "dart/wget" | "fsharp/laravel" | "fsharp/libcurl" | "fsharp/clj_http" | "fsharp/httpclient" | "fsharp/restsharp" | "fsharp/http" | "fsharp/native" | "fsharp/http1.1" | "fsharp/asynchttp" | "fsharp/nethttp" | "fsharp/okhttp" | "fsharp/unirest" | "fsharp/axios" | "fsharp/fetch" | "fsharp/jquery" | "fsharp/ofetch" | "fsharp/xhr" | "fsharp/undici" | "fsharp/nsurlsession" | "fsharp/cohttp" | "fsharp/curl" | "fsharp/guzzle" | "fsharp/restmethod" | "fsharp/webrequest" | "fsharp/python3" | "fsharp/requests" | "fsharp/aiohttp" | "fsharp/httpx_sync" | "fsharp/httpx_async" | "fsharp/httr2" | "fsharp/reqwest" | "fsharp/httpie" | "fsharp/wget" | "java/laravel" | "java/libcurl" | "java/clj_http" | "java/httpclient" | "java/restsharp" | "java/http" | "java/native" | "java/http1.1" | "java/asynchttp" | "java/nethttp" | "java/okhttp" | "java/unirest" | "java/axios" | "java/fetch" | "java/jquery" | "java/ofetch" | "java/xhr" | "java/undici" | "java/nsurlsession" | "java/cohttp" | "java/curl" | "java/guzzle" | "java/restmethod" | "java/webrequest" | "java/python3" | "java/requests" | "java/aiohttp" | "java/httpx_sync" | "java/httpx_async" | "java/httr2" | "java/reqwest" | "java/httpie" | "java/wget" | "js/laravel" | "js/libcurl" | "js/clj_http" | "js/httpclient" | "js/restsharp" | "js/http" | "js/native" | "js/http1.1" | "js/asynchttp" | "js/nethttp" | "js/okhttp" | "js/unirest" | "js/axios" | "js/fetch" | "js/jquery" | "js/ofetch" | "js/xhr" | "js/undici" | "js/nsurlsession" | "js/cohttp" | "js/curl" | "js/guzzle" | "js/restmethod" | "js/webrequest" | "js/python3" | "js/requests" | "js/aiohttp" | "js/httpx_sync" | "js/httpx_async" | "js/httr2" | "js/reqwest" | "js/httpie" | "js/wget" | "julia/laravel" | "julia/libcurl" | "julia/clj_http" | "julia/httpclient" | "julia/restsharp" | "julia/http" | "julia/native" | "julia/http1.1" | "julia/asynchttp" | "julia/nethttp" | "julia/okhttp" | "julia/unirest" | "julia/axios" | "julia/fetch" | "julia/jquery" | "julia/ofetch" | "julia/xhr" | "julia/undici" | "julia/nsurlsession" | "julia/cohttp" | "julia/curl" | "julia/guzzle" | "julia/restmethod" | "julia/webrequest" | "julia/python3" | "julia/requests" | "julia/aiohttp" | "julia/httpx_sync" | "julia/httpx_async" | "julia/httr2" | "julia/reqwest" | "julia/httpie" | "julia/wget" | "kotlin/laravel" | "kotlin/libcurl" | "kotlin/clj_http" | "kotlin/httpclient" | "kotlin/restsharp" | "kotlin/http" | "kotlin/native" | "kotlin/http1.1" | "kotlin/asynchttp" | "kotlin/nethttp" | "kotlin/okhttp" | "kotlin/unirest" | "kotlin/axios" | "kotlin/fetch" | "kotlin/jquery" | "kotlin/ofetch" | "kotlin/xhr" | "kotlin/undici" | "kotlin/nsurlsession" | "kotlin/cohttp" | "kotlin/curl" | "kotlin/guzzle" | "kotlin/restmethod" | "kotlin/webrequest" | "kotlin/python3" | "kotlin/requests" | "kotlin/aiohttp" | "kotlin/httpx_sync" | "kotlin/httpx_async" | "kotlin/httr2" | "kotlin/reqwest" | "kotlin/httpie" | "kotlin/wget" | "node/laravel" | "node/libcurl" | "node/clj_http" | "node/httpclient" | "node/restsharp" | "node/http" | "node/native" | "node/http1.1" | "node/asynchttp" | "node/nethttp" | "node/okhttp" | "node/unirest" | "node/axios" | "node/fetch" | "node/jquery" | "node/ofetch" | "node/xhr" | "node/undici" | "node/nsurlsession" | "node/cohttp" | "node/curl" | "node/guzzle" | "node/restmethod" | "node/webrequest" | "node/python3" | "node/requests" | "node/aiohttp" | "node/httpx_sync" | "node/httpx_async" | "node/httr2" | "node/reqwest" | "node/httpie" | "node/wget" | "objc/laravel" | "objc/libcurl" | "objc/clj_http" | "objc/httpclient" | "objc/restsharp" | "objc/http" | "objc/native" | "objc/http1.1" | "objc/asynchttp" | "objc/nethttp" | "objc/okhttp" | "objc/unirest" | "objc/axios" | "objc/fetch" | "objc/jquery" | "objc/ofetch" | "objc/xhr" | "objc/undici" | "objc/nsurlsession" | "objc/cohttp" | "objc/curl" | "objc/guzzle" | "objc/restmethod" | "objc/webrequest" | "objc/python3" | "objc/requests" | "objc/aiohttp" | "objc/httpx_sync" | "objc/httpx_async" | "objc/httr2" | "objc/reqwest" | "objc/httpie" | "objc/wget" | "ocaml/laravel" | "ocaml/libcurl" | "ocaml/clj_http" | "ocaml/httpclient" | "ocaml/restsharp" | "ocaml/http" | "ocaml/native" | "ocaml/http1.1" | "ocaml/asynchttp" | "ocaml/nethttp" | "ocaml/okhttp" | "ocaml/unirest" | "ocaml/axios" | "ocaml/fetch" | "ocaml/jquery" | "ocaml/ofetch" | "ocaml/xhr" | "ocaml/undici" | "ocaml/nsurlsession" | "ocaml/cohttp" | "ocaml/curl" | "ocaml/guzzle" | "ocaml/restmethod" | "ocaml/webrequest" | "ocaml/python3" | "ocaml/requests" | "ocaml/aiohttp" | "ocaml/httpx_sync" | "ocaml/httpx_async" | "ocaml/httr2" | "ocaml/reqwest" | "ocaml/httpie" | "ocaml/wget" | "php/laravel" | "php/libcurl" | "php/clj_http" | "php/httpclient" | "php/restsharp" | "php/http" | "php/native" | "php/http1.1" | "php/asynchttp" | "php/nethttp" | "php/okhttp" | "php/unirest" | "php/axios" | "php/fetch" | "php/jquery" | "php/ofetch" | "php/xhr" | "php/undici" | "php/nsurlsession" | "php/cohttp" | "php/curl" | "php/guzzle" | "php/restmethod" | "php/webrequest" | "php/python3" | "php/requests" | "php/aiohttp" | "php/httpx_sync" | "php/httpx_async" | "php/httr2" | "php/reqwest" | "php/httpie" | "php/wget" | "powershell/laravel" | "powershell/libcurl" | "powershell/clj_http" | "powershell/httpclient" | "powershell/restsharp" | "powershell/http" | "powershell/native" | "powershell/http1.1" | "powershell/asynchttp" | "powershell/nethttp" | "powershell/okhttp" | "powershell/unirest" | "powershell/axios" | "powershell/fetch" | "powershell/jquery" | "powershell/ofetch" | "powershell/xhr" | "powershell/undici" | "powershell/nsurlsession" | "powershell/cohttp" | "powershell/curl" | "powershell/guzzle" | "powershell/restmethod" | "powershell/webrequest" | "powershell/python3" | "powershell/requests" | "powershell/aiohttp" | "powershell/httpx_sync" | "powershell/httpx_async" | "powershell/httr2" | "powershell/reqwest" | "powershell/httpie" | "powershell/wget" | "python/laravel" | "python/libcurl" | "python/clj_http" | "python/httpclient" | "python/restsharp" | "python/http" | "python/native" | "python/http1.1" | "python/asynchttp" | "python/nethttp" | "python/okhttp" | "python/unirest" | "python/axios" | "python/fetch" | "python/jquery" | "python/ofetch" | "python/xhr" | "python/undici" | "python/nsurlsession" | "python/cohttp" | "python/curl" | "python/guzzle" | "python/restmethod" | "python/webrequest" | "python/python3" | "python/requests" | "python/aiohttp" | "python/httpx_sync" | "python/httpx_async" | "python/httr2" | "python/reqwest" | "python/httpie" | "python/wget" | "ruby/laravel" | "ruby/libcurl" | "ruby/clj_http" | "ruby/httpclient" | "ruby/restsharp" | "ruby/http" | "ruby/native" | "ruby/http1.1" | "ruby/asynchttp" | "ruby/nethttp" | "ruby/okhttp" | "ruby/unirest" | "ruby/axios" | "ruby/fetch" | "ruby/jquery" | "ruby/ofetch" | "ruby/xhr" | "ruby/undici" | "ruby/nsurlsession" | "ruby/cohttp" | "ruby/curl" | "ruby/guzzle" | "ruby/restmethod" | "ruby/webrequest" | "ruby/python3" | "ruby/requests" | "ruby/aiohttp" | "ruby/httpx_sync" | "ruby/httpx_async" | "ruby/httr2" | "ruby/reqwest" | "ruby/httpie" | "ruby/wget" | "shell/laravel" | "shell/libcurl" | "shell/clj_http" | "shell/httpclient" | "shell/restsharp" | "shell/http" | "shell/native" | "shell/http1.1" | "shell/asynchttp" | "shell/nethttp" | "shell/okhttp" | "shell/unirest" | "shell/axios" | "shell/fetch" | "shell/jquery" | "shell/ofetch" | "shell/xhr" | "shell/undici" | "shell/nsurlsession" | "shell/cohttp" | "shell/curl" | "shell/guzzle" | "shell/restmethod" | "shell/webrequest" | "shell/python3" | "shell/requests" | "shell/aiohttp" | "shell/httpx_sync" | "shell/httpx_async" | "shell/httr2" | "shell/reqwest" | "shell/httpie" | "shell/wget" | "swift/laravel" | "swift/libcurl" | "swift/clj_http" | "swift/httpclient" | "swift/restsharp" | "swift/http" | "swift/native" | "swift/http1.1" | "swift/asynchttp" | "swift/nethttp" | "swift/okhttp" | "swift/unirest" | "swift/axios" | "swift/fetch" | "swift/jquery" | "swift/ofetch" | "swift/xhr" | "swift/undici" | "swift/nsurlsession" | "swift/cohttp" | "swift/curl" | "swift/guzzle" | "swift/restmethod" | "swift/webrequest" | "swift/python3" | "swift/requests" | "swift/aiohttp" | "swift/httpx_sync" | "swift/httpx_async" | "swift/httr2" | "swift/reqwest" | "swift/httpie" | "swift/wget", "c" | "r" | "go" | "laravel" | "rust" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "julia" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift" | "c/laravel" | "c/libcurl" | "c/clj_http" | "c/httpclient" | "c/restsharp" | "c/http" | "c/native" | "c/http1.1" | "c/asynchttp" | "c/nethttp" | "c/okhttp" | "c/unirest" | "c/axios" | "c/fetch" | "c/jquery" | "c/ofetch" | "c/xhr" | "c/undici" | "c/nsurlsession" | "c/cohttp" | "c/curl" | "c/guzzle" | "c/restmethod" | "c/webrequest" | "c/python3" | "c/requests" | "c/aiohttp" | "c/httpx_sync" | "c/httpx_async" | "c/httr2" | "c/reqwest" | "c/httpie" | "c/wget" | "r/laravel" | "r/libcurl" | "r/clj_http" | "r/httpclient" | "r/restsharp" | "r/http" | "r/native" | "r/http1.1" | "r/asynchttp" | "r/nethttp" | "r/okhttp" | "r/unirest" | "r/axios" | "r/fetch" | "r/jquery" | "r/ofetch" | "r/xhr" | "r/undici" | "r/nsurlsession" | "r/cohttp" | "r/curl" | "r/guzzle" | "r/restmethod" | "r/webrequest" | "r/python3" | "r/requests" | "r/aiohttp" | "r/httpx_sync" | "r/httpx_async" | "r/httr2" | "r/reqwest" | "r/httpie" | "r/wget" | "go/laravel" | "go/libcurl" | "go/clj_http" | "go/httpclient" | "go/restsharp" | "go/http" | "go/native" | "go/http1.1" | "go/asynchttp" | "go/nethttp" | "go/okhttp" | "go/unirest" | "go/axios" | "go/fetch" | "go/jquery" | "go/ofetch" | "go/xhr" | "go/undici" | "go/nsurlsession" | "go/cohttp" | "go/curl" | "go/guzzle" | "go/restmethod" | "go/webrequest" | "go/python3" | "go/requests" | "go/aiohttp" | "go/httpx_sync" | "go/httpx_async" | "go/httr2" | "go/reqwest" | "go/httpie" | "go/wget" | "rust/laravel" | "rust/libcurl" | "rust/clj_http" | "rust/httpclient" | "rust/restsharp" | "rust/http" | "rust/native" | "rust/http1.1" | "rust/asynchttp" | "rust/nethttp" | "rust/okhttp" | "rust/unirest" | "rust/axios" | "rust/fetch" | "rust/jquery" | "rust/ofetch" | "rust/xhr" | "rust/undici" | "rust/nsurlsession" | "rust/cohttp" | "rust/curl" | "rust/guzzle" | "rust/restmethod" | "rust/webrequest" | "rust/python3" | "rust/requests" | "rust/aiohttp" | "rust/httpx_sync" | "rust/httpx_async" | "rust/httr2" | "rust/reqwest" | "rust/httpie" | "rust/wget" | "http/laravel" | "http/libcurl" | "http/clj_http" | "http/httpclient" | "http/restsharp" | "http/http" | "http/native" | "http/http1.1" | "http/asynchttp" | "http/nethttp" | "http/okhttp" | "http/unirest" | "http/axios" | "http/fetch" | "http/jquery" | "http/ofetch" | "http/xhr" | "http/undici" | "http/nsurlsession" | "http/cohttp" | "http/curl" | "http/guzzle" | "http/restmethod" | "http/webrequest" | "http/python3" | "http/requests" | "http/aiohttp" | "http/httpx_sync" | "http/httpx_async" | "http/httr2" | "http/reqwest" | "http/httpie" | "http/wget" | "clojure/laravel" | "clojure/libcurl" | "clojure/clj_http" | "clojure/httpclient" | "clojure/restsharp" | "clojure/http" | "clojure/native" | "clojure/http1.1" | "clojure/asynchttp" | "clojure/nethttp" | "clojure/okhttp" | "clojure/unirest" | "clojure/axios" | "clojure/fetch" | "clojure/jquery" | "clojure/ofetch" | "clojure/xhr" | "clojure/undici" | "clojure/nsurlsession" | "clojure/cohttp" | "clojure/curl" | "clojure/guzzle" | "clojure/restmethod" | "clojure/webrequest" | "clojure/python3" | "clojure/requests" | "clojure/aiohttp" | "clojure/httpx_sync" | "clojure/httpx_async" | "clojure/httr2" | "clojure/reqwest" | "clojure/httpie" | "clojure/wget" | "csharp/laravel" | "csharp/libcurl" | "csharp/clj_http" | "csharp/httpclient" | "csharp/restsharp" | "csharp/http" | "csharp/native" | "csharp/http1.1" | "csharp/asynchttp" | "csharp/nethttp" | "csharp/okhttp" | "csharp/unirest" | "csharp/axios" | "csharp/fetch" | "csharp/jquery" | "csharp/ofetch" | "csharp/xhr" | "csharp/undici" | "csharp/nsurlsession" | "csharp/cohttp" | "csharp/curl" | "csharp/guzzle" | "csharp/restmethod" | "csharp/webrequest" | "csharp/python3" | "csharp/requests" | "csharp/aiohttp" | "csharp/httpx_sync" | "csharp/httpx_async" | "csharp/httr2" | "csharp/reqwest" | "csharp/httpie" | "csharp/wget" | "dart/laravel" | "dart/libcurl" | "dart/clj_http" | "dart/httpclient" | "dart/restsharp" | "dart/http" | "dart/native" | "dart/http1.1" | "dart/asynchttp" | "dart/nethttp" | "dart/okhttp" | "dart/unirest" | "dart/axios" | "dart/fetch" | "dart/jquery" | "dart/ofetch" | "dart/xhr" | "dart/undici" | "dart/nsurlsession" | "dart/cohttp" | "dart/curl" | "dart/guzzle" | "dart/restmethod" | "dart/webrequest" | "dart/python3" | "dart/requests" | "dart/aiohttp" | "dart/httpx_sync" | "dart/httpx_async" | "dart/httr2" | "dart/reqwest" | "dart/httpie" | "dart/wget" | "fsharp/laravel" | "fsharp/libcurl" | "fsharp/clj_http" | "fsharp/httpclient" | "fsharp/restsharp" | "fsharp/http" | "fsharp/native" | "fsharp/http1.1" | "fsharp/asynchttp" | "fsharp/nethttp" | "fsharp/okhttp" | "fsharp/unirest" | "fsharp/axios" | "fsharp/fetch" | "fsharp/jquery" | "fsharp/ofetch" | "fsharp/xhr" | "fsharp/undici" | "fsharp/nsurlsession" | "fsharp/cohttp" | "fsharp/curl" | "fsharp/guzzle" | "fsharp/restmethod" | "fsharp/webrequest" | "fsharp/python3" | "fsharp/requests" | "fsharp/aiohttp" | "fsharp/httpx_sync" | "fsharp/httpx_async" | "fsharp/httr2" | "fsharp/reqwest" | "fsharp/httpie" | "fsharp/wget" | "java/laravel" | "java/libcurl" | "java/clj_http" | "java/httpclient" | "java/restsharp" | "java/http" | "java/native" | "java/http1.1" | "java/asynchttp" | "java/nethttp" | "java/okhttp" | "java/unirest" | "java/axios" | "java/fetch" | "java/jquery" | "java/ofetch" | "java/xhr" | "java/undici" | "java/nsurlsession" | "java/cohttp" | "java/curl" | "java/guzzle" | "java/restmethod" | "java/webrequest" | "java/python3" | "java/requests" | "java/aiohttp" | "java/httpx_sync" | "java/httpx_async" | "java/httr2" | "java/reqwest" | "java/httpie" | "java/wget" | "js/laravel" | "js/libcurl" | "js/clj_http" | "js/httpclient" | "js/restsharp" | "js/http" | "js/native" | "js/http1.1" | "js/asynchttp" | "js/nethttp" | "js/okhttp" | "js/unirest" | "js/axios" | "js/fetch" | "js/jquery" | "js/ofetch" | "js/xhr" | "js/undici" | "js/nsurlsession" | "js/cohttp" | "js/curl" | "js/guzzle" | "js/restmethod" | "js/webrequest" | "js/python3" | "js/requests" | "js/aiohttp" | "js/httpx_sync" | "js/httpx_async" | "js/httr2" | "js/reqwest" | "js/httpie" | "js/wget" | "julia/laravel" | "julia/libcurl" | "julia/clj_http" | "julia/httpclient" | "julia/restsharp" | "julia/http" | "julia/native" | "julia/http1.1" | "julia/asynchttp" | "julia/nethttp" | "julia/okhttp" | "julia/unirest" | "julia/axios" | "julia/fetch" | "julia/jquery" | "julia/ofetch" | "julia/xhr" | "julia/undici" | "julia/nsurlsession" | "julia/cohttp" | "julia/curl" | "julia/guzzle" | "julia/restmethod" | "julia/webrequest" | "julia/python3" | "julia/requests" | "julia/aiohttp" | "julia/httpx_sync" | "julia/httpx_async" | "julia/httr2" | "julia/reqwest" | "julia/httpie" | "julia/wget" | "kotlin/laravel" | "kotlin/libcurl" | "kotlin/clj_http" | "kotlin/httpclient" | "kotlin/restsharp" | "kotlin/http" | "kotlin/native" | "kotlin/http1.1" | "kotlin/asynchttp" | "kotlin/nethttp" | "kotlin/okhttp" | "kotlin/unirest" | "kotlin/axios" | "kotlin/fetch" | "kotlin/jquery" | "kotlin/ofetch" | "kotlin/xhr" | "kotlin/undici" | "kotlin/nsurlsession" | "kotlin/cohttp" | "kotlin/curl" | "kotlin/guzzle" | "kotlin/restmethod" | "kotlin/webrequest" | "kotlin/python3" | "kotlin/requests" | "kotlin/aiohttp" | "kotlin/httpx_sync" | "kotlin/httpx_async" | "kotlin/httr2" | "kotlin/reqwest" | "kotlin/httpie" | "kotlin/wget" | "node/laravel" | "node/libcurl" | "node/clj_http" | "node/httpclient" | "node/restsharp" | "node/http" | "node/native" | "node/http1.1" | "node/asynchttp" | "node/nethttp" | "node/okhttp" | "node/unirest" | "node/axios" | "node/fetch" | "node/jquery" | "node/ofetch" | "node/xhr" | "node/undici" | "node/nsurlsession" | "node/cohttp" | "node/curl" | "node/guzzle" | "node/restmethod" | "node/webrequest" | "node/python3" | "node/requests" | "node/aiohttp" | "node/httpx_sync" | "node/httpx_async" | "node/httr2" | "node/reqwest" | "node/httpie" | "node/wget" | "objc/laravel" | "objc/libcurl" | "objc/clj_http" | "objc/httpclient" | "objc/restsharp" | "objc/http" | "objc/native" | "objc/http1.1" | "objc/asynchttp" | "objc/nethttp" | "objc/okhttp" | "objc/unirest" | "objc/axios" | "objc/fetch" | "objc/jquery" | "objc/ofetch" | "objc/xhr" | "objc/undici" | "objc/nsurlsession" | "objc/cohttp" | "objc/curl" | "objc/guzzle" | "objc/restmethod" | "objc/webrequest" | "objc/python3" | "objc/requests" | "objc/aiohttp" | "objc/httpx_sync" | "objc/httpx_async" | "objc/httr2" | "objc/reqwest" | "objc/httpie" | "objc/wget" | "ocaml/laravel" | "ocaml/libcurl" | "ocaml/clj_http" | "ocaml/httpclient" | "ocaml/restsharp" | "ocaml/http" | "ocaml/native" | "ocaml/http1.1" | "ocaml/asynchttp" | "ocaml/nethttp" | "ocaml/okhttp" | "ocaml/unirest" | "ocaml/axios" | "ocaml/fetch" | "ocaml/jquery" | "ocaml/ofetch" | "ocaml/xhr" | "ocaml/undici" | "ocaml/nsurlsession" | "ocaml/cohttp" | "ocaml/curl" | "ocaml/guzzle" | "ocaml/restmethod" | "ocaml/webrequest" | "ocaml/python3" | "ocaml/requests" | "ocaml/aiohttp" | "ocaml/httpx_sync" | "ocaml/httpx_async" | "ocaml/httr2" | "ocaml/reqwest" | "ocaml/httpie" | "ocaml/wget" | "php/laravel" | "php/libcurl" | "php/clj_http" | "php/httpclient" | "php/restsharp" | "php/http" | "php/native" | "php/http1.1" | "php/asynchttp" | "php/nethttp" | "php/okhttp" | "php/unirest" | "php/axios" | "php/fetch" | "php/jquery" | "php/ofetch" | "php/xhr" | "php/undici" | "php/nsurlsession" | "php/cohttp" | "php/curl" | "php/guzzle" | "php/restmethod" | "php/webrequest" | "php/python3" | "php/requests" | "php/aiohttp" | "php/httpx_sync" | "php/httpx_async" | "php/httr2" | "php/reqwest" | "php/httpie" | "php/wget" | "powershell/laravel" | "powershell/libcurl" | "powershell/clj_http" | "powershell/httpclient" | "powershell/restsharp" | "powershell/http" | "powershell/native" | "powershell/http1.1" | "powershell/asynchttp" | "powershell/nethttp" | "powershell/okhttp" | "powershell/unirest" | "powershell/axios" | "powershell/fetch" | "powershell/jquery" | "powershell/ofetch" | "powershell/xhr" | "powershell/undici" | "powershell/nsurlsession" | "powershell/cohttp" | "powershell/curl" | "powershell/guzzle" | "powershell/restmethod" | "powershell/webrequest" | "powershell/python3" | "powershell/requests" | "powershell/aiohttp" | "powershell/httpx_sync" | "powershell/httpx_async" | "powershell/httr2" | "powershell/reqwest" | "powershell/httpie" | "powershell/wget" | "python/laravel" | "python/libcurl" | "python/clj_http" | "python/httpclient" | "python/restsharp" | "python/http" | "python/native" | "python/http1.1" | "python/asynchttp" | "python/nethttp" | "python/okhttp" | "python/unirest" | "python/axios" | "python/fetch" | "python/jquery" | "python/ofetch" | "python/xhr" | "python/undici" | "python/nsurlsession" | "python/cohttp" | "python/curl" | "python/guzzle" | "python/restmethod" | "python/webrequest" | "python/python3" | "python/requests" | "python/aiohttp" | "python/httpx_sync" | "python/httpx_async" | "python/httr2" | "python/reqwest" | "python/httpie" | "python/wget" | "ruby/laravel" | "ruby/libcurl" | "ruby/clj_http" | "ruby/httpclient" | "ruby/restsharp" | "ruby/http" | "ruby/native" | "ruby/http1.1" | "ruby/asynchttp" | "ruby/nethttp" | "ruby/okhttp" | "ruby/unirest" | "ruby/axios" | "ruby/fetch" | "ruby/jquery" | "ruby/ofetch" | "ruby/xhr" | "ruby/undici" | "ruby/nsurlsession" | "ruby/cohttp" | "ruby/curl" | "ruby/guzzle" | "ruby/restmethod" | "ruby/webrequest" | "ruby/python3" | "ruby/requests" | "ruby/aiohttp" | "ruby/httpx_sync" | "ruby/httpx_async" | "ruby/httr2" | "ruby/reqwest" | "ruby/httpie" | "ruby/wget" | "shell/laravel" | "shell/libcurl" | "shell/clj_http" | "shell/httpclient" | "shell/restsharp" | "shell/http" | "shell/native" | "shell/http1.1" | "shell/asynchttp" | "shell/nethttp" | "shell/okhttp" | "shell/unirest" | "shell/axios" | "shell/fetch" | "shell/jquery" | "shell/ofetch" | "shell/xhr" | "shell/undici" | "shell/nsurlsession" | "shell/cohttp" | "shell/curl" | "shell/guzzle" | "shell/restmethod" | "shell/webrequest" | "shell/python3" | "shell/requests" | "shell/aiohttp" | "shell/httpx_sync" | "shell/httpx_async" | "shell/httr2" | "shell/reqwest" | "shell/httpie" | "shell/wget" | "swift/laravel" | "swift/libcurl" | "swift/clj_http" | "swift/httpclient" | "swift/restsharp" | "swift/http" | "swift/native" | "swift/http1.1" | "swift/asynchttp" | "swift/nethttp" | "swift/okhttp" | "swift/unirest" | "swift/axios" | "swift/fetch" | "swift/jquery" | "swift/ofetch" | "swift/xhr" | "swift/undici" | "swift/nsurlsession" | "swift/cohttp" | "swift/curl" | "swift/guzzle" | "swift/restmethod" | "swift/webrequest" | "swift/python3" | "swift/requests" | "swift/aiohttp" | "swift/httpx_sync" | "swift/httpx_async" | "swift/httr2" | "swift/reqwest" | "swift/httpie" | "swift/wget">>, z.ZodLiteral<true>]>>;
    defaultHttpClient: z.ZodOptional<z.ZodObject<{
        targetKey: z.ZodCustom<"c" | "r" | "go" | "rust" | "http" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "julia" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift", "c" | "r" | "go" | "rust" | "http" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "julia" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift">;
        clientKey: z.ZodCustom<"laravel" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget", "laravel" | "libcurl" | "clj_http" | "httpclient" | "restsharp" | "http" | "native" | "http1.1" | "asynchttp" | "nethttp" | "okhttp" | "unirest" | "axios" | "fetch" | "jquery" | "ofetch" | "xhr" | "undici" | "nsurlsession" | "cohttp" | "curl" | "guzzle" | "restmethod" | "webrequest" | "python3" | "requests" | "aiohttp" | "httpx_sync" | "httpx_async" | "httr2" | "reqwest" | "httpie" | "wget">;
    }, z.core.$strip>>;
    featuredClients: z.ZodOptional<z.ZodArray<z.ZodCustom<"c/laravel" | "c/libcurl" | "c/clj_http" | "c/httpclient" | "c/restsharp" | "c/http" | "c/native" | "c/http1.1" | "c/asynchttp" | "c/nethttp" | "c/okhttp" | "c/unirest" | "c/axios" | "c/fetch" | "c/jquery" | "c/ofetch" | "c/xhr" | "c/undici" | "c/nsurlsession" | "c/cohttp" | "c/curl" | "c/guzzle" | "c/restmethod" | "c/webrequest" | "c/python3" | "c/requests" | "c/aiohttp" | "c/httpx_sync" | "c/httpx_async" | "c/httr2" | "c/reqwest" | "c/httpie" | "c/wget" | "r/laravel" | "r/libcurl" | "r/clj_http" | "r/httpclient" | "r/restsharp" | "r/http" | "r/native" | "r/http1.1" | "r/asynchttp" | "r/nethttp" | "r/okhttp" | "r/unirest" | "r/axios" | "r/fetch" | "r/jquery" | "r/ofetch" | "r/xhr" | "r/undici" | "r/nsurlsession" | "r/cohttp" | "r/curl" | "r/guzzle" | "r/restmethod" | "r/webrequest" | "r/python3" | "r/requests" | "r/aiohttp" | "r/httpx_sync" | "r/httpx_async" | "r/httr2" | "r/reqwest" | "r/httpie" | "r/wget" | "go/laravel" | "go/libcurl" | "go/clj_http" | "go/httpclient" | "go/restsharp" | "go/http" | "go/native" | "go/http1.1" | "go/asynchttp" | "go/nethttp" | "go/okhttp" | "go/unirest" | "go/axios" | "go/fetch" | "go/jquery" | "go/ofetch" | "go/xhr" | "go/undici" | "go/nsurlsession" | "go/cohttp" | "go/curl" | "go/guzzle" | "go/restmethod" | "go/webrequest" | "go/python3" | "go/requests" | "go/aiohttp" | "go/httpx_sync" | "go/httpx_async" | "go/httr2" | "go/reqwest" | "go/httpie" | "go/wget" | "rust/laravel" | "rust/libcurl" | "rust/clj_http" | "rust/httpclient" | "rust/restsharp" | "rust/http" | "rust/native" | "rust/http1.1" | "rust/asynchttp" | "rust/nethttp" | "rust/okhttp" | "rust/unirest" | "rust/axios" | "rust/fetch" | "rust/jquery" | "rust/ofetch" | "rust/xhr" | "rust/undici" | "rust/nsurlsession" | "rust/cohttp" | "rust/curl" | "rust/guzzle" | "rust/restmethod" | "rust/webrequest" | "rust/python3" | "rust/requests" | "rust/aiohttp" | "rust/httpx_sync" | "rust/httpx_async" | "rust/httr2" | "rust/reqwest" | "rust/httpie" | "rust/wget" | "http/laravel" | "http/libcurl" | "http/clj_http" | "http/httpclient" | "http/restsharp" | "http/http" | "http/native" | "http/http1.1" | "http/asynchttp" | "http/nethttp" | "http/okhttp" | "http/unirest" | "http/axios" | "http/fetch" | "http/jquery" | "http/ofetch" | "http/xhr" | "http/undici" | "http/nsurlsession" | "http/cohttp" | "http/curl" | "http/guzzle" | "http/restmethod" | "http/webrequest" | "http/python3" | "http/requests" | "http/aiohttp" | "http/httpx_sync" | "http/httpx_async" | "http/httr2" | "http/reqwest" | "http/httpie" | "http/wget" | "clojure/laravel" | "clojure/libcurl" | "clojure/clj_http" | "clojure/httpclient" | "clojure/restsharp" | "clojure/http" | "clojure/native" | "clojure/http1.1" | "clojure/asynchttp" | "clojure/nethttp" | "clojure/okhttp" | "clojure/unirest" | "clojure/axios" | "clojure/fetch" | "clojure/jquery" | "clojure/ofetch" | "clojure/xhr" | "clojure/undici" | "clojure/nsurlsession" | "clojure/cohttp" | "clojure/curl" | "clojure/guzzle" | "clojure/restmethod" | "clojure/webrequest" | "clojure/python3" | "clojure/requests" | "clojure/aiohttp" | "clojure/httpx_sync" | "clojure/httpx_async" | "clojure/httr2" | "clojure/reqwest" | "clojure/httpie" | "clojure/wget" | "csharp/laravel" | "csharp/libcurl" | "csharp/clj_http" | "csharp/httpclient" | "csharp/restsharp" | "csharp/http" | "csharp/native" | "csharp/http1.1" | "csharp/asynchttp" | "csharp/nethttp" | "csharp/okhttp" | "csharp/unirest" | "csharp/axios" | "csharp/fetch" | "csharp/jquery" | "csharp/ofetch" | "csharp/xhr" | "csharp/undici" | "csharp/nsurlsession" | "csharp/cohttp" | "csharp/curl" | "csharp/guzzle" | "csharp/restmethod" | "csharp/webrequest" | "csharp/python3" | "csharp/requests" | "csharp/aiohttp" | "csharp/httpx_sync" | "csharp/httpx_async" | "csharp/httr2" | "csharp/reqwest" | "csharp/httpie" | "csharp/wget" | "dart/laravel" | "dart/libcurl" | "dart/clj_http" | "dart/httpclient" | "dart/restsharp" | "dart/http" | "dart/native" | "dart/http1.1" | "dart/asynchttp" | "dart/nethttp" | "dart/okhttp" | "dart/unirest" | "dart/axios" | "dart/fetch" | "dart/jquery" | "dart/ofetch" | "dart/xhr" | "dart/undici" | "dart/nsurlsession" | "dart/cohttp" | "dart/curl" | "dart/guzzle" | "dart/restmethod" | "dart/webrequest" | "dart/python3" | "dart/requests" | "dart/aiohttp" | "dart/httpx_sync" | "dart/httpx_async" | "dart/httr2" | "dart/reqwest" | "dart/httpie" | "dart/wget" | "fsharp/laravel" | "fsharp/libcurl" | "fsharp/clj_http" | "fsharp/httpclient" | "fsharp/restsharp" | "fsharp/http" | "fsharp/native" | "fsharp/http1.1" | "fsharp/asynchttp" | "fsharp/nethttp" | "fsharp/okhttp" | "fsharp/unirest" | "fsharp/axios" | "fsharp/fetch" | "fsharp/jquery" | "fsharp/ofetch" | "fsharp/xhr" | "fsharp/undici" | "fsharp/nsurlsession" | "fsharp/cohttp" | "fsharp/curl" | "fsharp/guzzle" | "fsharp/restmethod" | "fsharp/webrequest" | "fsharp/python3" | "fsharp/requests" | "fsharp/aiohttp" | "fsharp/httpx_sync" | "fsharp/httpx_async" | "fsharp/httr2" | "fsharp/reqwest" | "fsharp/httpie" | "fsharp/wget" | "java/laravel" | "java/libcurl" | "java/clj_http" | "java/httpclient" | "java/restsharp" | "java/http" | "java/native" | "java/http1.1" | "java/asynchttp" | "java/nethttp" | "java/okhttp" | "java/unirest" | "java/axios" | "java/fetch" | "java/jquery" | "java/ofetch" | "java/xhr" | "java/undici" | "java/nsurlsession" | "java/cohttp" | "java/curl" | "java/guzzle" | "java/restmethod" | "java/webrequest" | "java/python3" | "java/requests" | "java/aiohttp" | "java/httpx_sync" | "java/httpx_async" | "java/httr2" | "java/reqwest" | "java/httpie" | "java/wget" | "js/laravel" | "js/libcurl" | "js/clj_http" | "js/httpclient" | "js/restsharp" | "js/http" | "js/native" | "js/http1.1" | "js/asynchttp" | "js/nethttp" | "js/okhttp" | "js/unirest" | "js/axios" | "js/fetch" | "js/jquery" | "js/ofetch" | "js/xhr" | "js/undici" | "js/nsurlsession" | "js/cohttp" | "js/curl" | "js/guzzle" | "js/restmethod" | "js/webrequest" | "js/python3" | "js/requests" | "js/aiohttp" | "js/httpx_sync" | "js/httpx_async" | "js/httr2" | "js/reqwest" | "js/httpie" | "js/wget" | "julia/laravel" | "julia/libcurl" | "julia/clj_http" | "julia/httpclient" | "julia/restsharp" | "julia/http" | "julia/native" | "julia/http1.1" | "julia/asynchttp" | "julia/nethttp" | "julia/okhttp" | "julia/unirest" | "julia/axios" | "julia/fetch" | "julia/jquery" | "julia/ofetch" | "julia/xhr" | "julia/undici" | "julia/nsurlsession" | "julia/cohttp" | "julia/curl" | "julia/guzzle" | "julia/restmethod" | "julia/webrequest" | "julia/python3" | "julia/requests" | "julia/aiohttp" | "julia/httpx_sync" | "julia/httpx_async" | "julia/httr2" | "julia/reqwest" | "julia/httpie" | "julia/wget" | "kotlin/laravel" | "kotlin/libcurl" | "kotlin/clj_http" | "kotlin/httpclient" | "kotlin/restsharp" | "kotlin/http" | "kotlin/native" | "kotlin/http1.1" | "kotlin/asynchttp" | "kotlin/nethttp" | "kotlin/okhttp" | "kotlin/unirest" | "kotlin/axios" | "kotlin/fetch" | "kotlin/jquery" | "kotlin/ofetch" | "kotlin/xhr" | "kotlin/undici" | "kotlin/nsurlsession" | "kotlin/cohttp" | "kotlin/curl" | "kotlin/guzzle" | "kotlin/restmethod" | "kotlin/webrequest" | "kotlin/python3" | "kotlin/requests" | "kotlin/aiohttp" | "kotlin/httpx_sync" | "kotlin/httpx_async" | "kotlin/httr2" | "kotlin/reqwest" | "kotlin/httpie" | "kotlin/wget" | "node/laravel" | "node/libcurl" | "node/clj_http" | "node/httpclient" | "node/restsharp" | "node/http" | "node/native" | "node/http1.1" | "node/asynchttp" | "node/nethttp" | "node/okhttp" | "node/unirest" | "node/axios" | "node/fetch" | "node/jquery" | "node/ofetch" | "node/xhr" | "node/undici" | "node/nsurlsession" | "node/cohttp" | "node/curl" | "node/guzzle" | "node/restmethod" | "node/webrequest" | "node/python3" | "node/requests" | "node/aiohttp" | "node/httpx_sync" | "node/httpx_async" | "node/httr2" | "node/reqwest" | "node/httpie" | "node/wget" | "objc/laravel" | "objc/libcurl" | "objc/clj_http" | "objc/httpclient" | "objc/restsharp" | "objc/http" | "objc/native" | "objc/http1.1" | "objc/asynchttp" | "objc/nethttp" | "objc/okhttp" | "objc/unirest" | "objc/axios" | "objc/fetch" | "objc/jquery" | "objc/ofetch" | "objc/xhr" | "objc/undici" | "objc/nsurlsession" | "objc/cohttp" | "objc/curl" | "objc/guzzle" | "objc/restmethod" | "objc/webrequest" | "objc/python3" | "objc/requests" | "objc/aiohttp" | "objc/httpx_sync" | "objc/httpx_async" | "objc/httr2" | "objc/reqwest" | "objc/httpie" | "objc/wget" | "ocaml/laravel" | "ocaml/libcurl" | "ocaml/clj_http" | "ocaml/httpclient" | "ocaml/restsharp" | "ocaml/http" | "ocaml/native" | "ocaml/http1.1" | "ocaml/asynchttp" | "ocaml/nethttp" | "ocaml/okhttp" | "ocaml/unirest" | "ocaml/axios" | "ocaml/fetch" | "ocaml/jquery" | "ocaml/ofetch" | "ocaml/xhr" | "ocaml/undici" | "ocaml/nsurlsession" | "ocaml/cohttp" | "ocaml/curl" | "ocaml/guzzle" | "ocaml/restmethod" | "ocaml/webrequest" | "ocaml/python3" | "ocaml/requests" | "ocaml/aiohttp" | "ocaml/httpx_sync" | "ocaml/httpx_async" | "ocaml/httr2" | "ocaml/reqwest" | "ocaml/httpie" | "ocaml/wget" | "php/laravel" | "php/libcurl" | "php/clj_http" | "php/httpclient" | "php/restsharp" | "php/http" | "php/native" | "php/http1.1" | "php/asynchttp" | "php/nethttp" | "php/okhttp" | "php/unirest" | "php/axios" | "php/fetch" | "php/jquery" | "php/ofetch" | "php/xhr" | "php/undici" | "php/nsurlsession" | "php/cohttp" | "php/curl" | "php/guzzle" | "php/restmethod" | "php/webrequest" | "php/python3" | "php/requests" | "php/aiohttp" | "php/httpx_sync" | "php/httpx_async" | "php/httr2" | "php/reqwest" | "php/httpie" | "php/wget" | "powershell/laravel" | "powershell/libcurl" | "powershell/clj_http" | "powershell/httpclient" | "powershell/restsharp" | "powershell/http" | "powershell/native" | "powershell/http1.1" | "powershell/asynchttp" | "powershell/nethttp" | "powershell/okhttp" | "powershell/unirest" | "powershell/axios" | "powershell/fetch" | "powershell/jquery" | "powershell/ofetch" | "powershell/xhr" | "powershell/undici" | "powershell/nsurlsession" | "powershell/cohttp" | "powershell/curl" | "powershell/guzzle" | "powershell/restmethod" | "powershell/webrequest" | "powershell/python3" | "powershell/requests" | "powershell/aiohttp" | "powershell/httpx_sync" | "powershell/httpx_async" | "powershell/httr2" | "powershell/reqwest" | "powershell/httpie" | "powershell/wget" | "python/laravel" | "python/libcurl" | "python/clj_http" | "python/httpclient" | "python/restsharp" | "python/http" | "python/native" | "python/http1.1" | "python/asynchttp" | "python/nethttp" | "python/okhttp" | "python/unirest" | "python/axios" | "python/fetch" | "python/jquery" | "python/ofetch" | "python/xhr" | "python/undici" | "python/nsurlsession" | "python/cohttp" | "python/curl" | "python/guzzle" | "python/restmethod" | "python/webrequest" | "python/python3" | "python/requests" | "python/aiohttp" | "python/httpx_sync" | "python/httpx_async" | "python/httr2" | "python/reqwest" | "python/httpie" | "python/wget" | "ruby/laravel" | "ruby/libcurl" | "ruby/clj_http" | "ruby/httpclient" | "ruby/restsharp" | "ruby/http" | "ruby/native" | "ruby/http1.1" | "ruby/asynchttp" | "ruby/nethttp" | "ruby/okhttp" | "ruby/unirest" | "ruby/axios" | "ruby/fetch" | "ruby/jquery" | "ruby/ofetch" | "ruby/xhr" | "ruby/undici" | "ruby/nsurlsession" | "ruby/cohttp" | "ruby/curl" | "ruby/guzzle" | "ruby/restmethod" | "ruby/webrequest" | "ruby/python3" | "ruby/requests" | "ruby/aiohttp" | "ruby/httpx_sync" | "ruby/httpx_async" | "ruby/httr2" | "ruby/reqwest" | "ruby/httpie" | "ruby/wget" | "shell/laravel" | "shell/libcurl" | "shell/clj_http" | "shell/httpclient" | "shell/restsharp" | "shell/http" | "shell/native" | "shell/http1.1" | "shell/asynchttp" | "shell/nethttp" | "shell/okhttp" | "shell/unirest" | "shell/axios" | "shell/fetch" | "shell/jquery" | "shell/ofetch" | "shell/xhr" | "shell/undici" | "shell/nsurlsession" | "shell/cohttp" | "shell/curl" | "shell/guzzle" | "shell/restmethod" | "shell/webrequest" | "shell/python3" | "shell/requests" | "shell/aiohttp" | "shell/httpx_sync" | "shell/httpx_async" | "shell/httr2" | "shell/reqwest" | "shell/httpie" | "shell/wget" | "swift/laravel" | "swift/libcurl" | "swift/clj_http" | "swift/httpclient" | "swift/restsharp" | "swift/http" | "swift/native" | "swift/http1.1" | "swift/asynchttp" | "swift/nethttp" | "swift/okhttp" | "swift/unirest" | "swift/axios" | "swift/fetch" | "swift/jquery" | "swift/ofetch" | "swift/xhr" | "swift/undici" | "swift/nsurlsession" | "swift/cohttp" | "swift/curl" | "swift/guzzle" | "swift/restmethod" | "swift/webrequest" | "swift/python3" | "swift/requests" | "swift/aiohttp" | "swift/httpx_sync" | "swift/httpx_async" | "swift/httr2" | "swift/reqwest" | "swift/httpie" | "swift/wget", "c/laravel" | "c/libcurl" | "c/clj_http" | "c/httpclient" | "c/restsharp" | "c/http" | "c/native" | "c/http1.1" | "c/asynchttp" | "c/nethttp" | "c/okhttp" | "c/unirest" | "c/axios" | "c/fetch" | "c/jquery" | "c/ofetch" | "c/xhr" | "c/undici" | "c/nsurlsession" | "c/cohttp" | "c/curl" | "c/guzzle" | "c/restmethod" | "c/webrequest" | "c/python3" | "c/requests" | "c/aiohttp" | "c/httpx_sync" | "c/httpx_async" | "c/httr2" | "c/reqwest" | "c/httpie" | "c/wget" | "r/laravel" | "r/libcurl" | "r/clj_http" | "r/httpclient" | "r/restsharp" | "r/http" | "r/native" | "r/http1.1" | "r/asynchttp" | "r/nethttp" | "r/okhttp" | "r/unirest" | "r/axios" | "r/fetch" | "r/jquery" | "r/ofetch" | "r/xhr" | "r/undici" | "r/nsurlsession" | "r/cohttp" | "r/curl" | "r/guzzle" | "r/restmethod" | "r/webrequest" | "r/python3" | "r/requests" | "r/aiohttp" | "r/httpx_sync" | "r/httpx_async" | "r/httr2" | "r/reqwest" | "r/httpie" | "r/wget" | "go/laravel" | "go/libcurl" | "go/clj_http" | "go/httpclient" | "go/restsharp" | "go/http" | "go/native" | "go/http1.1" | "go/asynchttp" | "go/nethttp" | "go/okhttp" | "go/unirest" | "go/axios" | "go/fetch" | "go/jquery" | "go/ofetch" | "go/xhr" | "go/undici" | "go/nsurlsession" | "go/cohttp" | "go/curl" | "go/guzzle" | "go/restmethod" | "go/webrequest" | "go/python3" | "go/requests" | "go/aiohttp" | "go/httpx_sync" | "go/httpx_async" | "go/httr2" | "go/reqwest" | "go/httpie" | "go/wget" | "rust/laravel" | "rust/libcurl" | "rust/clj_http" | "rust/httpclient" | "rust/restsharp" | "rust/http" | "rust/native" | "rust/http1.1" | "rust/asynchttp" | "rust/nethttp" | "rust/okhttp" | "rust/unirest" | "rust/axios" | "rust/fetch" | "rust/jquery" | "rust/ofetch" | "rust/xhr" | "rust/undici" | "rust/nsurlsession" | "rust/cohttp" | "rust/curl" | "rust/guzzle" | "rust/restmethod" | "rust/webrequest" | "rust/python3" | "rust/requests" | "rust/aiohttp" | "rust/httpx_sync" | "rust/httpx_async" | "rust/httr2" | "rust/reqwest" | "rust/httpie" | "rust/wget" | "http/laravel" | "http/libcurl" | "http/clj_http" | "http/httpclient" | "http/restsharp" | "http/http" | "http/native" | "http/http1.1" | "http/asynchttp" | "http/nethttp" | "http/okhttp" | "http/unirest" | "http/axios" | "http/fetch" | "http/jquery" | "http/ofetch" | "http/xhr" | "http/undici" | "http/nsurlsession" | "http/cohttp" | "http/curl" | "http/guzzle" | "http/restmethod" | "http/webrequest" | "http/python3" | "http/requests" | "http/aiohttp" | "http/httpx_sync" | "http/httpx_async" | "http/httr2" | "http/reqwest" | "http/httpie" | "http/wget" | "clojure/laravel" | "clojure/libcurl" | "clojure/clj_http" | "clojure/httpclient" | "clojure/restsharp" | "clojure/http" | "clojure/native" | "clojure/http1.1" | "clojure/asynchttp" | "clojure/nethttp" | "clojure/okhttp" | "clojure/unirest" | "clojure/axios" | "clojure/fetch" | "clojure/jquery" | "clojure/ofetch" | "clojure/xhr" | "clojure/undici" | "clojure/nsurlsession" | "clojure/cohttp" | "clojure/curl" | "clojure/guzzle" | "clojure/restmethod" | "clojure/webrequest" | "clojure/python3" | "clojure/requests" | "clojure/aiohttp" | "clojure/httpx_sync" | "clojure/httpx_async" | "clojure/httr2" | "clojure/reqwest" | "clojure/httpie" | "clojure/wget" | "csharp/laravel" | "csharp/libcurl" | "csharp/clj_http" | "csharp/httpclient" | "csharp/restsharp" | "csharp/http" | "csharp/native" | "csharp/http1.1" | "csharp/asynchttp" | "csharp/nethttp" | "csharp/okhttp" | "csharp/unirest" | "csharp/axios" | "csharp/fetch" | "csharp/jquery" | "csharp/ofetch" | "csharp/xhr" | "csharp/undici" | "csharp/nsurlsession" | "csharp/cohttp" | "csharp/curl" | "csharp/guzzle" | "csharp/restmethod" | "csharp/webrequest" | "csharp/python3" | "csharp/requests" | "csharp/aiohttp" | "csharp/httpx_sync" | "csharp/httpx_async" | "csharp/httr2" | "csharp/reqwest" | "csharp/httpie" | "csharp/wget" | "dart/laravel" | "dart/libcurl" | "dart/clj_http" | "dart/httpclient" | "dart/restsharp" | "dart/http" | "dart/native" | "dart/http1.1" | "dart/asynchttp" | "dart/nethttp" | "dart/okhttp" | "dart/unirest" | "dart/axios" | "dart/fetch" | "dart/jquery" | "dart/ofetch" | "dart/xhr" | "dart/undici" | "dart/nsurlsession" | "dart/cohttp" | "dart/curl" | "dart/guzzle" | "dart/restmethod" | "dart/webrequest" | "dart/python3" | "dart/requests" | "dart/aiohttp" | "dart/httpx_sync" | "dart/httpx_async" | "dart/httr2" | "dart/reqwest" | "dart/httpie" | "dart/wget" | "fsharp/laravel" | "fsharp/libcurl" | "fsharp/clj_http" | "fsharp/httpclient" | "fsharp/restsharp" | "fsharp/http" | "fsharp/native" | "fsharp/http1.1" | "fsharp/asynchttp" | "fsharp/nethttp" | "fsharp/okhttp" | "fsharp/unirest" | "fsharp/axios" | "fsharp/fetch" | "fsharp/jquery" | "fsharp/ofetch" | "fsharp/xhr" | "fsharp/undici" | "fsharp/nsurlsession" | "fsharp/cohttp" | "fsharp/curl" | "fsharp/guzzle" | "fsharp/restmethod" | "fsharp/webrequest" | "fsharp/python3" | "fsharp/requests" | "fsharp/aiohttp" | "fsharp/httpx_sync" | "fsharp/httpx_async" | "fsharp/httr2" | "fsharp/reqwest" | "fsharp/httpie" | "fsharp/wget" | "java/laravel" | "java/libcurl" | "java/clj_http" | "java/httpclient" | "java/restsharp" | "java/http" | "java/native" | "java/http1.1" | "java/asynchttp" | "java/nethttp" | "java/okhttp" | "java/unirest" | "java/axios" | "java/fetch" | "java/jquery" | "java/ofetch" | "java/xhr" | "java/undici" | "java/nsurlsession" | "java/cohttp" | "java/curl" | "java/guzzle" | "java/restmethod" | "java/webrequest" | "java/python3" | "java/requests" | "java/aiohttp" | "java/httpx_sync" | "java/httpx_async" | "java/httr2" | "java/reqwest" | "java/httpie" | "java/wget" | "js/laravel" | "js/libcurl" | "js/clj_http" | "js/httpclient" | "js/restsharp" | "js/http" | "js/native" | "js/http1.1" | "js/asynchttp" | "js/nethttp" | "js/okhttp" | "js/unirest" | "js/axios" | "js/fetch" | "js/jquery" | "js/ofetch" | "js/xhr" | "js/undici" | "js/nsurlsession" | "js/cohttp" | "js/curl" | "js/guzzle" | "js/restmethod" | "js/webrequest" | "js/python3" | "js/requests" | "js/aiohttp" | "js/httpx_sync" | "js/httpx_async" | "js/httr2" | "js/reqwest" | "js/httpie" | "js/wget" | "julia/laravel" | "julia/libcurl" | "julia/clj_http" | "julia/httpclient" | "julia/restsharp" | "julia/http" | "julia/native" | "julia/http1.1" | "julia/asynchttp" | "julia/nethttp" | "julia/okhttp" | "julia/unirest" | "julia/axios" | "julia/fetch" | "julia/jquery" | "julia/ofetch" | "julia/xhr" | "julia/undici" | "julia/nsurlsession" | "julia/cohttp" | "julia/curl" | "julia/guzzle" | "julia/restmethod" | "julia/webrequest" | "julia/python3" | "julia/requests" | "julia/aiohttp" | "julia/httpx_sync" | "julia/httpx_async" | "julia/httr2" | "julia/reqwest" | "julia/httpie" | "julia/wget" | "kotlin/laravel" | "kotlin/libcurl" | "kotlin/clj_http" | "kotlin/httpclient" | "kotlin/restsharp" | "kotlin/http" | "kotlin/native" | "kotlin/http1.1" | "kotlin/asynchttp" | "kotlin/nethttp" | "kotlin/okhttp" | "kotlin/unirest" | "kotlin/axios" | "kotlin/fetch" | "kotlin/jquery" | "kotlin/ofetch" | "kotlin/xhr" | "kotlin/undici" | "kotlin/nsurlsession" | "kotlin/cohttp" | "kotlin/curl" | "kotlin/guzzle" | "kotlin/restmethod" | "kotlin/webrequest" | "kotlin/python3" | "kotlin/requests" | "kotlin/aiohttp" | "kotlin/httpx_sync" | "kotlin/httpx_async" | "kotlin/httr2" | "kotlin/reqwest" | "kotlin/httpie" | "kotlin/wget" | "node/laravel" | "node/libcurl" | "node/clj_http" | "node/httpclient" | "node/restsharp" | "node/http" | "node/native" | "node/http1.1" | "node/asynchttp" | "node/nethttp" | "node/okhttp" | "node/unirest" | "node/axios" | "node/fetch" | "node/jquery" | "node/ofetch" | "node/xhr" | "node/undici" | "node/nsurlsession" | "node/cohttp" | "node/curl" | "node/guzzle" | "node/restmethod" | "node/webrequest" | "node/python3" | "node/requests" | "node/aiohttp" | "node/httpx_sync" | "node/httpx_async" | "node/httr2" | "node/reqwest" | "node/httpie" | "node/wget" | "objc/laravel" | "objc/libcurl" | "objc/clj_http" | "objc/httpclient" | "objc/restsharp" | "objc/http" | "objc/native" | "objc/http1.1" | "objc/asynchttp" | "objc/nethttp" | "objc/okhttp" | "objc/unirest" | "objc/axios" | "objc/fetch" | "objc/jquery" | "objc/ofetch" | "objc/xhr" | "objc/undici" | "objc/nsurlsession" | "objc/cohttp" | "objc/curl" | "objc/guzzle" | "objc/restmethod" | "objc/webrequest" | "objc/python3" | "objc/requests" | "objc/aiohttp" | "objc/httpx_sync" | "objc/httpx_async" | "objc/httr2" | "objc/reqwest" | "objc/httpie" | "objc/wget" | "ocaml/laravel" | "ocaml/libcurl" | "ocaml/clj_http" | "ocaml/httpclient" | "ocaml/restsharp" | "ocaml/http" | "ocaml/native" | "ocaml/http1.1" | "ocaml/asynchttp" | "ocaml/nethttp" | "ocaml/okhttp" | "ocaml/unirest" | "ocaml/axios" | "ocaml/fetch" | "ocaml/jquery" | "ocaml/ofetch" | "ocaml/xhr" | "ocaml/undici" | "ocaml/nsurlsession" | "ocaml/cohttp" | "ocaml/curl" | "ocaml/guzzle" | "ocaml/restmethod" | "ocaml/webrequest" | "ocaml/python3" | "ocaml/requests" | "ocaml/aiohttp" | "ocaml/httpx_sync" | "ocaml/httpx_async" | "ocaml/httr2" | "ocaml/reqwest" | "ocaml/httpie" | "ocaml/wget" | "php/laravel" | "php/libcurl" | "php/clj_http" | "php/httpclient" | "php/restsharp" | "php/http" | "php/native" | "php/http1.1" | "php/asynchttp" | "php/nethttp" | "php/okhttp" | "php/unirest" | "php/axios" | "php/fetch" | "php/jquery" | "php/ofetch" | "php/xhr" | "php/undici" | "php/nsurlsession" | "php/cohttp" | "php/curl" | "php/guzzle" | "php/restmethod" | "php/webrequest" | "php/python3" | "php/requests" | "php/aiohttp" | "php/httpx_sync" | "php/httpx_async" | "php/httr2" | "php/reqwest" | "php/httpie" | "php/wget" | "powershell/laravel" | "powershell/libcurl" | "powershell/clj_http" | "powershell/httpclient" | "powershell/restsharp" | "powershell/http" | "powershell/native" | "powershell/http1.1" | "powershell/asynchttp" | "powershell/nethttp" | "powershell/okhttp" | "powershell/unirest" | "powershell/axios" | "powershell/fetch" | "powershell/jquery" | "powershell/ofetch" | "powershell/xhr" | "powershell/undici" | "powershell/nsurlsession" | "powershell/cohttp" | "powershell/curl" | "powershell/guzzle" | "powershell/restmethod" | "powershell/webrequest" | "powershell/python3" | "powershell/requests" | "powershell/aiohttp" | "powershell/httpx_sync" | "powershell/httpx_async" | "powershell/httr2" | "powershell/reqwest" | "powershell/httpie" | "powershell/wget" | "python/laravel" | "python/libcurl" | "python/clj_http" | "python/httpclient" | "python/restsharp" | "python/http" | "python/native" | "python/http1.1" | "python/asynchttp" | "python/nethttp" | "python/okhttp" | "python/unirest" | "python/axios" | "python/fetch" | "python/jquery" | "python/ofetch" | "python/xhr" | "python/undici" | "python/nsurlsession" | "python/cohttp" | "python/curl" | "python/guzzle" | "python/restmethod" | "python/webrequest" | "python/python3" | "python/requests" | "python/aiohttp" | "python/httpx_sync" | "python/httpx_async" | "python/httr2" | "python/reqwest" | "python/httpie" | "python/wget" | "ruby/laravel" | "ruby/libcurl" | "ruby/clj_http" | "ruby/httpclient" | "ruby/restsharp" | "ruby/http" | "ruby/native" | "ruby/http1.1" | "ruby/asynchttp" | "ruby/nethttp" | "ruby/okhttp" | "ruby/unirest" | "ruby/axios" | "ruby/fetch" | "ruby/jquery" | "ruby/ofetch" | "ruby/xhr" | "ruby/undici" | "ruby/nsurlsession" | "ruby/cohttp" | "ruby/curl" | "ruby/guzzle" | "ruby/restmethod" | "ruby/webrequest" | "ruby/python3" | "ruby/requests" | "ruby/aiohttp" | "ruby/httpx_sync" | "ruby/httpx_async" | "ruby/httr2" | "ruby/reqwest" | "ruby/httpie" | "ruby/wget" | "shell/laravel" | "shell/libcurl" | "shell/clj_http" | "shell/httpclient" | "shell/restsharp" | "shell/http" | "shell/native" | "shell/http1.1" | "shell/asynchttp" | "shell/nethttp" | "shell/okhttp" | "shell/unirest" | "shell/axios" | "shell/fetch" | "shell/jquery" | "shell/ofetch" | "shell/xhr" | "shell/undici" | "shell/nsurlsession" | "shell/cohttp" | "shell/curl" | "shell/guzzle" | "shell/restmethod" | "shell/webrequest" | "shell/python3" | "shell/requests" | "shell/aiohttp" | "shell/httpx_sync" | "shell/httpx_async" | "shell/httr2" | "shell/reqwest" | "shell/httpie" | "shell/wget" | "swift/laravel" | "swift/libcurl" | "swift/clj_http" | "swift/httpclient" | "swift/restsharp" | "swift/http" | "swift/native" | "swift/http1.1" | "swift/asynchttp" | "swift/nethttp" | "swift/okhttp" | "swift/unirest" | "swift/axios" | "swift/fetch" | "swift/jquery" | "swift/ofetch" | "swift/xhr" | "swift/undici" | "swift/nsurlsession" | "swift/cohttp" | "swift/curl" | "swift/guzzle" | "swift/restmethod" | "swift/webrequest" | "swift/python3" | "swift/requests" | "swift/aiohttp" | "swift/httpx_sync" | "swift/httpx_async" | "swift/httr2" | "swift/reqwest" | "swift/httpie" | "swift/wget">>>;
    defaultRequestBodyView: z.ZodOptional<z.ZodEnum<{
        form: "form";
        raw: "raw";
    }>>;
    customCss: z.ZodOptional<z.ZodString>;
    onServerChange: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>;
    onDocumentSelect: z.ZodType<(() => Promise<void> | void) | undefined>;
    onLoaded: z.ZodType<((slug: string) => Promise<void> | void) | undefined>;
    onBeforeRequest: z.ZodType<((a: {
        request: Request;
        requestBuilder: any;
        envVariables: Record<string, string>;
    }) => Promise<void> | void) | undefined>;
    onRequestBuilt: z.ZodType<((a: {
        request: Request;
        requestBuilder: any;
        envVariables: Record<string, string>;
    }) => Promise<void> | void) | undefined>;
    onResponseReceived: z.ZodType<((input: {
        response: Response;
        request: Request;
    }) => Response | void | Promise<Response | void>) | undefined>;
    onShowMore: z.ZodType<((a: string) => Promise<void> | void) | undefined>;
    onSidebarClick: z.ZodType<((a: string) => Promise<void> | void) | undefined>;
    pathRouting: z.ZodOptional<z.ZodObject<{
        basePath: z.ZodString;
    }, z.core.$strip>>;
    mcp: z.ZodOptional<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        url: z.ZodOptional<z.ZodString>;
        disabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    generateHeadingSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        slug: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateModelSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateTagSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateOperationSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        path: z.ZodString;
        operationId: z.ZodOptional<z.ZodString>;
        method: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateWebhookSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodString;
        method: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    setPageTitle: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        title: z.ZodString;
        document: z.ZodObject<{
            title: z.ZodString;
            slug: z.ZodString;
        }, z.core.$strip>;
    }, z.core.$strip>], null>, z.ZodString>>;
    redirect: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodOptional<z.ZodNullable<z.ZodString>>>>;
    withDefaultFonts: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    defaultOpenFirstTag: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    defaultOpenAllTags: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllModelSections: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllParameters: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllResponses: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllSchemaProperties: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    maxVisibleRequestBodyProperties: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodNumber>>>;
    tagsSorter: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodFunction<z.ZodTuple<readonly [z.ZodAny, z.ZodAny], null>, z.ZodNumber>]>>;
    operationsSorter: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodLiteral<"method">, z.ZodFunction<z.ZodTuple<readonly [z.ZodAny, z.ZodAny], null>, z.ZodNumber>]>>;
    orderSchemaPropertiesBy: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodLiteral<"preserve">]>>>>;
    schemaKeyboardNav: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    orderRequiredPropertiesFirst: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
}, z.core.$strip>;
/**
 * Pure configuration without the sources
 *
 * @deprecated Remove this once the types have been fully migrated
 */
export type ApiReferenceConfigurationRaw = Omit<z.infer<typeof apiReferenceConfigurationSchema>, // Remove deprecated attributes
// Remove deprecated attributes
'proxy' | 'spec' | 'authentication' | 'showToolbar'> & {
    authentication?: AuthenticationConfiguration;
};
/**
 * Configuration for the Scalar Api Reference integrations
 *
 * See the type `ApiReferenceConfigurationWithSource` or `AnyApiReferenceConfiguration`\
 * for the configuration that includes the sources for you OpenAPI documents
 */
export type ApiReferenceConfiguration = ApiReferenceConfigurationRaw & {
    /** @deprecated
     * This type now refers to the base configuration that does not include the sources.
     * Use the type `ApiReferenceConfigurationWithSource` instead.
     */
    url?: SourceConfiguration['url'];
    /** @deprecated
     * This type now refers to the base configuration that does not include the sources.
     * Use the type `ApiReferenceConfigurationWithSource` instead.
     */
    content?: SourceConfiguration['content'];
    /**
     * Fired before the outbound request is built and sent. Mutate the **request builder** so the eventual fetch call
     * reflects your changes (method, path, headers, body, and related fields).
     *
     * The `request` passed here is **not** the object sent over the wire; the actual request is rebuilt from the builder
     * afterwards. Use `onRequestBuilt` instead when you need the exact outgoing request (for example, to hash a
     * `multipart/form-data` body for request signing).
     *
     * **Experimental:** The builder matches {@link https://github.com/scalar/scalar/blob/main/packages/workspace-store/src/request-example/builder/request-factory.ts RequestFactory}
     * (`import type { RequestFactory } from '@scalar/workspace-store/request-example'`). That shape is still experimental and may change in minor releases.
     *
     * @param input - Hook argument from the integration layer.
     * @param input.request - **Deprecated** when treated as a fetch API `Request`. Prefer thinking of this value as the
     * mutable builder ({@link https://github.com/scalar/scalar/blob/main/packages/workspace-store/src/request-example/builder/request-factory.ts RequestFactory}).
     * Some call sites only pass this property.
     * @param input.requestBuilder - The same builder when exposed under this name; **prefer** mutating this when your integration provides it.
     * @returns void or a promise that resolves when the hook finishes
     * @example
     * ```ts
     * onBeforeRequest: ({ request: builder }) => {
     *   builder.headers.set('Authorization', 'Bearer <token>')
     * }
     * ```
     */
    onBeforeRequest?: (input: {
        request: Request;
        requestBuilder: any;
        envVariables: Record<string, string>;
    }) => void | Promise<void> | undefined;
    /**
     * Fired before response processing. Return a Response to replace the body, status, or headers
     * used by the client, or return nothing to keep the current response. Receives a clone so
     * reading the body does not consume the client response. Avoid reading unbounded streams.
     */
    onResponseReceived?: (input: {
        response: Response;
        request: Request;
    }) => Response | void | Promise<Response | void>;
    /**
     * Fired after the outbound fetch `Request` has been built, right before it is sent. The `request` is the exact
     * object handed to fetch: mutating its headers modifies the outgoing request, and hashing its body produces a
     * hash that matches what the server receives (useful for request signing — a rebuilt `multipart/form-data` body
     * would get a different boundary).
     *
     * Use `onBeforeRequest` instead when you need to mutate the request builder (method, path, query, body,
     * security); those mutations have no effect at this stage because the request is already built.
     *
     * **Experimental:** This API may change in minor releases.
     *
     * @param input - Hook argument from the integration layer.
     * @param input.request - The exact fetch API `Request` that will be sent. Mutate its headers to modify the outgoing request.
     * @param input.requestBuilder - The builder the request was built from, for inspection. Mutating it has no effect at this stage.
     * @param input.envVariables - Resolved environment variables for the active environment.
     * @returns void or a promise that resolves when the hook finishes
     * @example
     * ```ts
     * onRequestBuilt: async ({ request }) => {
     *   const bodyHash = await hash(await request.clone().arrayBuffer())
     *   request.headers.set('X-Body-Hash', bodyHash)
     * }
     * ```
     */
    onRequestBuilt?: (input: {
        request: Request;
        requestBuilder: any;
        envVariables: Record<string, string>;
    }) => void | Promise<void> | undefined;
};
/** Migrate the configuration through a transform */
/** Configuration for the Api Reference */
export declare const apiReferenceConfigurationWithSourceSchema: ZodType<Omit<ApiReferenceConfiguration, 'url' | 'content'> & SourceConfiguration>;
/**
 * User facing configuration that includes the document source configuration
 */
export type ApiReferenceConfigurationWithSource = Omit<z.infer<typeof apiReferenceConfigurationWithSourceSchema>, 'proxy' | 'spec' | 'authentication' | 'showToolbar'> & {
    authentication?: AuthenticationConfiguration;
};
/**
 * Configuration for a single config with multiple sources
 * The configuration will be shared between the documents
 */
export type ApiReferenceConfigurationWithMultipleSources = ApiReferenceConfigurationWithSource & {
    sources: SourceConfiguration[];
};
/** Configuration for multiple Api References */
export type AnyApiReferenceConfiguration = Partial<ApiReferenceConfigurationWithSource> | Partial<ApiReferenceConfigurationWithMultipleSources> | Partial<ApiReferenceConfigurationWithSource>[] | Partial<ApiReferenceConfigurationWithMultipleSources>[];
//# sourceMappingURL=api-reference-configuration.d.ts.map