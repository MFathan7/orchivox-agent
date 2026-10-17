/** Select the first declared content entry, preserving its media-type parameters and value. */
export const getFirstMediaType = (content) => Object.entries(content ?? {})[0];
