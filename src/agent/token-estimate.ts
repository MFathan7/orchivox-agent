/**
 * Approximate token cost by script. English is about four characters per token,
 * but Arabic, CJK, and JSON are far denser. A plain chars/4 estimate sees a
 * 51k-character Arabic payload as 13k tokens when it can cost several times that.
 */
export function estimateTokenCost(text: string): number {
  if (!text) return 0;
  let latin = 0;
  let cjk = 0;
  let dense = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) latin += 1;
    else if (isCjk(codePoint)) cjk += 1;
    else if (isDenseScript(codePoint)) dense += 1;
    else other += 1;
  }
  return Math.ceil(latin / 4 + cjk + dense / 2 + other / 3);
}

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x2e80 && codePoint <= 0x2fff) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3100 && codePoint <= 0x318f) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff)
  );
}

function isDenseScript(codePoint: number): boolean {
  return (
    (codePoint >= 0x0590 && codePoint <= 0x05ff) ||
    (codePoint >= 0x0600 && codePoint <= 0x06ff) ||
    (codePoint >= 0x0750 && codePoint <= 0x077f) ||
    (codePoint >= 0x08a0 && codePoint <= 0x08ff) ||
    (codePoint >= 0x0900 && codePoint <= 0x0dff) ||
    (codePoint >= 0x0e00 && codePoint <= 0x0eff) ||
    (codePoint >= 0x0f00 && codePoint <= 0x0fff) ||
    (codePoint >= 0x1000 && codePoint <= 0x109f) ||
    (codePoint >= 0x1780 && codePoint <= 0x17ff) ||
    (codePoint >= 0x1e00 && codePoint <= 0x1eff)
  );
}
