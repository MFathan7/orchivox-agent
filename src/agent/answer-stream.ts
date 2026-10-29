export interface AnswerStream {
  text: string;
}

export function createAnswerStream(): AnswerStream {
  return { text: "" };
}

export function appendAnswerToken(stream: AnswerStream, token: string): void {
  if (token.length > 0) stream.text += token;
}

export function replaceAnswer(stream: AnswerStream, text: string): void {
  stream.text = text;
}

export function takeAnswer(stream: AnswerStream): string {
  const text = stream.text;
  stream.text = "";
  return text;
}
