export interface SecretFinding {
  line: number;
  kind: string;
  preview: string;
}

const SECRET_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "nvidia-key", pattern: /nvapi-[A-Za-z0-9_-]{10,}/ },
  { kind: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "github-token", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { kind: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "aws-key", pattern: /AKIA[0-9A-Z]{16}/ },
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

export function redactSecrets(text: string): string {
  return text
    .replace(
      /(nvapi-|sk-|ghp_|xox[baprs]-|AKIA)[A-Za-z0-9_-]+/g,
      "$1[redacted]",
    )
    .replace(
      /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----).*/g,
      "$1[redacted]",
    );
}

export function scanTextForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const { kind, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({
          line: index + 1,
          kind,
          preview: redactSecrets(line.trim()).slice(0, 160),
        });
      }
    }
  }
  return findings;
}
