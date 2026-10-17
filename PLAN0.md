```markdown
Kamu adalah Principal Systems Architect dan Staff TypeScript/Bun Engineer. Kita sedang membangun proyek AI Coding Agent pribadi bernama `Orchivox Agent` (`orchivox-agent`) menggunakan runtime **Bun** (v1.1+) dan **TypeScript 5+**.
Agent ini memiliki fitur presisi kode tingkat IDE, in-process builtins, subagent terisolasi Git Worktree, Time-Traveling Stream Rules, Plan/Ultrawork mode, Dynamic TypeScript Plugins, serta Dual-Direction Universal OpenAPI & OpenClaude Gateway.

ATURAN WAJIB KODE (STRICT RULES):
1. DILARANG KERAS menulis kode potongan, stub, menyebutkan nama kompetitor di dalam kode/komentar, atau menulis komentar seperti `// TODO: implement` atau `// ... rest of code`. Setiap file yang kamu hasilkan harus 100% lengkap, lolos type-check, dan siap produksi.
2. Gunakan fitur native Bun secara optimal (`bun:sqlite`, `Bun.serve`, `Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.hash`, `Bun.spawn`) dan `zod` untuk semua validasi skema runtime maupun pembuatan JSON Schema.
3. Gunakan `AbortController` dan `AsyncGenerator` untuk manajemen streaming dan pembatalan proses yang bersih.

Sebagai langkah pertama (Langkah 0), buatkan secara lengkap dan utuh 5 file berikut:
1. `package.json`: Deklarasikan proyek `orchivox-agent` (`"type": "module"`) beserta scripts (`start`, `serve`, `build:binary` dengan `bun build ./src/index.ts --compile --outfile orchivox`, `typecheck`) dan dependencies utama (`zod`, `zod-to-json-schema`, `yaml`, `hono`, `@hono/zod-openapi`, `@scalar/hono-api-reference`, `@modelcontextprotocol/sdk`, `diff`, `ink`, `react`, `chalk`).
2. `tsconfig.json`: Konfigurasi TypeScript modern untuk Bun (`"moduleResolution": "bundler"`, `"jsx": "react-jsx"`, `"strict": true`, `"types": ["bun-types"]`).
3. `.agent/config.yaml`: Contoh file konfigurasi lengkap yang mendefinisikan:
   - Multi-provider profiles (OpenAI custom BaseURL, Anthropic/OpenClaude custom BaseURL, Ollama lokal, OpenRouter)
   - Role assignment (`main_model`, `fast_model`, `advisor_model`)
   - Pengaturan Inbound Server (`port`, `api_key`, `enable_openapi`, `enable_openclaude`)
   - Pengaturan LSP servers per bahasa, MCP servers, dan Sandbox permissions.
4. `src/types/schema.ts`: Semua skema Zod dan tipe TypeScript (`z.infer`) yang digunakan lintas modul:
   - `RoleSchema`, `ContentBlockSchema` (`text`, `tool_use`, `tool_result`, `thinking`), `MessageSchema`
   - `ToolDefinitionSchema` (mendukung parameter Zod maupun JSON Schema), `ToolCallSchema`, `ToolResultSchema`
   - `StreamEvent` union type (`token`, `thinking_token`, `tool_call_delta`, `tool_call_ready`, `usage`, `rule_violation`, `error`, `done`)
   - `AgentModeSchema` (`plan`, `build`, `ultrawork`)
   - `SubagentSpecSchema`, `SubagentStatusSchema`, `SubagentResultSchema`
   - `TodoItemSchema` (`id`, `task`, `status`, `priority`)
5. `src/config/loader.ts`: Parser `.agent/config.yaml` menggunakan package `yaml` dan validasi `zod`, lengkap dengan substitusi variabel environment (`${ENV_VAR}`) serta fallback ke nilai default yang aman jika file konfigurasi belum ada.
```