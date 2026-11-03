const global = process.env.npm_config_global === "true";

if (!global) {
  const lines = [
    "",
    "Orchivox is installed in this project.",
    "A local npm install does not add it to your shell PATH.",
    "Run it with: npx orchivox",
    "For a global command: npm install -g orchivox",
  ];
  if (process.platform === "win32") {
    lines.push(
      "If PowerShell blocks the npm shim, run from the project root:",
      "  node node_modules\\orchivox\\bin\\launcher.mjs",
    );
  }
  lines.push("The runtime is downloaded on the first run.", "");
  console.log(lines.join("\n"));
}
