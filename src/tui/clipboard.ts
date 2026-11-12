interface ClipboardOptions {
  platform?: NodeJS.Platform;
  write?: (sequence: string) => unknown;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: (argv: string[], text: string) => Promise<boolean>;
}

async function runClipboardCommand(argv: string[], text: string): Promise<boolean> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const command = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child = command;
    timer = setTimeout(() => command.kill(), 1500);
    command.stdin.write(text);
    command.stdin.end();
    return await command.exited === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (child?.exitCode === null) child.kill();
  }
}

export async function copyTextToClipboard(text: string, options: ClipboardOptions = {}): Promise<"system" | "terminal"> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const run = options.run ?? runClipboardCommand;
  const commands = platform === "darwin" ? [["pbcopy"]] : platform === "linux"
    ? [["wl-copy", "--type", "text/plain;charset=utf-8"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]] : [];
  for (const command of commands) if (await run(command, text)) return "system";
  if ((options.isTTY ?? process.stdout.isTTY) && env.TERM !== "dumb") {
    const write = options.write ?? ((sequence: string) => process.stdout.write(sequence));
    write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
    return "terminal";
  }
  throw new Error("Clipboard unavailable. Use Shift+drag and your terminal's Copy action.");
}
