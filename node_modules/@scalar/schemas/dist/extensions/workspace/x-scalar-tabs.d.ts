export declare const Tab: import("@scalar/validation").ObjectSchema<{
    path: import("@scalar/validation").StringSchema;
    title: import("@scalar/validation").StringSchema;
    icon: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
}>;
/**
 * Schema for workspace tab configuration.
 *
 * This extension allows storing the list of open tabs and which tab is currently active.
 * Useful for preserving the user workspace state across sessions.
 */
export declare const XScalarTabs: import("@scalar/validation").ObjectSchema<{
    'x-scalar-tabs': import("@scalar/validation").OptionalSchema<import("@scalar/validation").ArraySchema<import("@scalar/validation").ObjectSchema<{
        path: import("@scalar/validation").StringSchema;
        title: import("@scalar/validation").StringSchema;
        icon: import("@scalar/validation").OptionalSchema<import("@scalar/validation").StringSchema>;
    }>>>;
    'x-scalar-active-tab': import("@scalar/validation").OptionalSchema<import("@scalar/validation").NumberSchema>;
}>;
//# sourceMappingURL=x-scalar-tabs.d.ts.map