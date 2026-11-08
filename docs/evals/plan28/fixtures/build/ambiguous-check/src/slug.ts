export function slugify(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "-");
}
