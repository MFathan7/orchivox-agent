export interface AnswerStream {
  text: string;
  needsSeparator: boolean;
}

export function createAnswerStream(): AnswerStream {
  return { text: "", needsSeparator: false };
}

export function markAnswerBoundary(stream: AnswerStream): void {
  if (stream.text.trim().length > 0) stream.needsSeparator = true;
}

export function appendAnswerToken(stream: AnswerStream, token: string): void {
  if (token.length === 0) return;
  if (stream.needsSeparator && !stream.text.endsWith("\n\n")) {
    stream.text += stream.text.endsWith("\n") ? "\n" : "\n\n";
  }
  stream.text += token;
  stream.needsSeparator = false;
}

export function replaceAnswer(stream: AnswerStream, text: string): void {
  stream.text = text;
  stream.needsSeparator = false;
}
