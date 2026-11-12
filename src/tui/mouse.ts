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

export interface MousePointerEvent {
  x: number;
  y: number;
  type: "press" | "drag" | "release";
}

export function parseMousePointerEvents(data: string): MousePointerEvent[] {
  const events: MousePointerEvent[] = [];
  for (const match of data.matchAll(/\u001b\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const button = Number(match[1]);
    if ((button & 64) !== 0 || (button & 3) !== 0) continue;
    events.push({
      x: Number(match[2]),
      y: Number(match[3]),
      type: match[4] === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press",
    });
  }
  return events;
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
