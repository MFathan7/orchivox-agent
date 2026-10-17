/** Default label for the components.schemas section. Preserves the historical `Models` wording and the `#models` hash. */
export const DEFAULT_MODELS_SECTION_LABEL = 'Models';
/** Typeguard to check to narrow the configs to the one with sources */
export const isConfigurationWithSources = (config) => Boolean(!Array.isArray(config) && config && 'sources' in config && Array.isArray(config.sources));
