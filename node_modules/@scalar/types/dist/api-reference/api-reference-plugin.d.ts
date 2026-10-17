import type { MarkdownRenderHook } from '@scalar/helpers/markdown/markdown-render-hook';
import { z } from 'zod';
declare const openApiExtensionSchema: z.ZodObject<{
    name: z.ZodString;
    component: z.ZodUnknown;
    renderer: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
declare const viewComponentSchema: z.ZodObject<{
    component: z.ZodUnknown;
    renderer: z.ZodOptional<z.ZodUnknown>;
    props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
    sidebar: z.ZodOptional<z.ZodObject<{
        show: z.ZodDefault<z.ZodBoolean>;
        label: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * Read-only view of the stored secrets for a single security scheme.
 *
 * The concrete shape depends on the scheme `type` (`apiKey`, `http`, `oauth2`, `openIdConnect`),
 * so only `type` is guaranteed. The remaining fields (tokens, credentials, per-flow secrets) are
 * exposed loosely to avoid coupling the plugin API to the workspace store's internal schema.
 */
export type PluginAuthSecrets = {
    type: string;
} & Record<string, unknown>;
/** Read-only view of the selected security for a document or operation. */
export type PluginSelectedSecurity = {
    /** Index of the currently selected security requirement. */
    selectedIndex: number;
    /** The selected security requirements, each mapping a scheme name to its selected scopes. */
    selectedSchemes: Array<Record<string, string[]>>;
};
/** Read-only view of the entire authentication state, keyed by document name. */
export type PluginDocumentAuth = Record<string, {
    /** Stored secrets keyed by security scheme name. */
    secrets: Record<string, PluginAuthSecrets>;
    /** Selected security schemes at the document and operation level. */
    selected: {
        document?: PluginSelectedSecurity;
        path?: Record<string, Record<string, PluginSelectedSecurity | undefined>>;
    };
}>;
/**
 * Read-only accessor for the global authentication state.
 *
 * Passed to plugin lifecycle hooks (`onInit`, `onConfigChange`) and exposed via the plugin
 * manager (`getAuthState`) so plugins can read stored secrets and selected security schemes
 * without being able to mutate them.
 */
export type PluginAuthState = {
    /** Returns a plain snapshot of the entire authentication state, keyed by document name. */
    export: () => PluginDocumentAuth;
    /** Returns the stored secrets for a security scheme within a document, or `undefined` if none. */
    getAuthSecrets: (documentName: string, schemeName: string) => PluginAuthSecrets | undefined;
    /** Returns the selected security for a document or operation, or `undefined` if none. */
    getAuthSelectedSchemas: (payload: {
        type: 'document';
        documentName: string;
    } | {
        type: 'operation';
        documentName: string;
        path: string;
        method: string;
    }) => PluginSelectedSecurity | undefined;
};
declare const lifecycleHooksSchema: z.ZodObject<{
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
        auth: z.ZodCustom<PluginAuthState, PluginAuthState>;
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
        auth: z.ZodCustom<PluginAuthState, PluginAuthState>;
    }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
    onDestroy: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [], null>, z.core.$ZodFunctionOut>>;
}, z.core.$strip>;
export declare const apiReferencePluginSchema: z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
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
    markdown: z.ZodOptional<z.ZodCustom<MarkdownRenderHook, MarkdownRenderHook>>;
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
            auth: z.ZodCustom<PluginAuthState, PluginAuthState>;
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
            auth: z.ZodCustom<PluginAuthState, PluginAuthState>;
        }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
        onDestroy: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [], null>, z.core.$ZodFunctionOut>>;
    }, z.core.$strip>>;
    apiClientPlugins: z.ZodOptional<z.ZodArray<z.ZodAny>>;
}, z.core.$strip>>;
export type SpecificationExtension = z.infer<typeof openApiExtensionSchema>;
export type ViewComponent = z.infer<typeof viewComponentSchema>;
export type LifecycleHooks = z.infer<typeof lifecycleHooksSchema>;
export type ApiReferencePlugin = z.infer<typeof apiReferencePluginSchema>;
export {};
//# sourceMappingURL=api-reference-plugin.d.ts.map