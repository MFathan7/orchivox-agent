export function parseMouseWheel(data: string): number {
  let delta = 0;
  const pattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of data.matchAll(pattern)) {
    const button = Number(match[1]);
    if ((button & 64) === 0) continue;
    delta += (button & 1) === 0 ? 1 : -1;
  }
  return delta;
}

export interface MouseClick {
  x: number;
  y: number;
  button: number;
}

export function parseMouseClick(data: string): MouseClick | undefined {
  const pattern = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of data.matchAll(pattern)) {
    const button = Number(match[1]);
    if ((button & 64) !== 0) continue;
    if ((button & 32) !== 0) continue;
    if ((button & 3) !== 0) continue;
    if (match[4] !== "M") continue;
    return {
      x: Number(match[2]),
      y: Number(match[3]),
      button,
    };
  }
  return undefined;
}

export function isMouseSequence(input: string): boolean {
  return input.startsWith("\u001b[<") || input.startsWith("[<");
}
