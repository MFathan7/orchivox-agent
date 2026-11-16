export function isMcpServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name) && !["__proto__", "constructor", "prototype"].includes(name);
}
