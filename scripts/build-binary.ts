// Ink imports react-devtools-core only when DEV=true, but Bun still resolves
// the static import while compiling. Stub it so the binary has no optional
// peer dependency at runtime.
const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  compile: {
    outfile: "./orchivox",
  },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "orchivox-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "orchivox-stub" }, () => ({
          contents: "export default { connectToDevTools() {} };",
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const output = result.outputs[0]?.path;
console.log(`built ${output ?? "orchivox"}`);

export {};
