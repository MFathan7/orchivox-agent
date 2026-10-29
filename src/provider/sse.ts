export interface SseMessage {
  event: string | undefined;
  data: string;
}

const RECORD_BOUNDARY = /\r?\n\r?\n/;

export async function* iterateSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = RECORD_BOUNDARY.exec(buffer);
      while (boundary) {
        const record = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const message = parseSseRecord(record);
        if (message) yield message;
        boundary = RECORD_BOUNDARY.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const trailing = parseSseRecord(buffer);
    if (trailing) yield trailing;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function parseSseRecord(record: string): SseMessage | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of record.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length === 0 && event === undefined) return undefined;
  return { event, data: data.join("\n") };
}
