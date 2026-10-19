export function findMissingModels(
  configured: readonly string[],
  installed: readonly string[],
): string[] {
  const available = new Set(installed);
  return configured.filter((model) => !available.has(model));
}
