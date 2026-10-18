# Models and capabilities

Orchivox routes a turn to the provider and model assigned to a role:

| Role | Used for |
| --- | --- |
| `main` | Normal turns and specialist agents without their own role |
| `fast` | Quick helper calls |
| `advisor` | Background diff review |

`/models` opens the manager. It scans local runtimes first (Ollama on
`127.0.0.1:11434`, LM Studio on `1234`, llama.cpp on `8080`, vLLM on `8000`)
and lists discovered models under **Local models**. **Another platforms**
connects OpenAI, Anthropic, OpenRouter, or a custom OpenAI-compatible URL.
Selecting a discovered model registers the provider and assigns it to the
current role.

## Capability metadata

Capabilities are inferred from the provider kind and model name, then can be
overridden per model in `.agent/config.yaml`:

```yaml
providers:
  ollama:
    kind: ollama
    base_url: http://127.0.0.1:11434/v1
    models:
      - qwen2.5-coder:7b
    model_capabilities:
      qwen2.5-coder:7b:
        tool_calling: true
        reasoning: false
        vision: false
        context_window: 32768
        max_output: 4096
```

| Field | Effect |
| --- | --- |
| `tool_calling` | When false, tools and `tool_choice` are omitted from the request. |
| `reasoning` | Enables reasoning effort: `reasoning_effort` for OpenAI, `thinking.budget_tokens` for Anthropic. Reasoning deltas stream into the Thinking block. |
| `vision` | Sends attached images as native image blocks. When false, images become a text note and the model can delegate with `inspect_image`. |
| `context_window` | Compaction runs at 75% of this value. |
| `max_output` | Clamps `max_tokens` for the request. |

The model manager shows the resolved capabilities for the selected model in
the assign list. Press `Ctrl+E` there to edit them: `Space`/`Enter` toggles a
capability, `Left`/`Right` or number keys change the limits, `s` saves, and
`r` resets the model to the inferred values. Inferred defaults cover common
OpenAI, Anthropic, DeepSeek R1, Qwen VL, and Llama vision names.

## Images

Attach an image with `@screenshot.png` in the composer. Supported formats are
PNG, JPEG, WebP, and GIF, up to 5 MB and four images per message. When the
active model has `vision`, Orchivox sends the image as a native image block to
OpenAI-compatible and Anthropic-compatible providers.

Non-vision models receive a text note with the file path. They can call
`inspect_image` with `imagePath` to delegate analysis to a vision-capable
`advisor` or `main` model. `inspect_image` performs a real provider call and
also accepts an HTTP URL or the system clipboard.

Image bytes are never written to the session database. Only an
`[image: path]` marker is stored, and resumed sessions keep that marker.

## Token accounting

The header formats the active session total compactly (`12.3k tok ·
$0.0042`). `/stats` shows the exact total plus input/output tokens.
Session totals are persisted and restored when a session is resumed.
