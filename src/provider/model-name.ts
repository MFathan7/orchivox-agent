const ACRONYMS: Record<string, string> = {
  ai: "AI",
  api: "API",
  asr: "ASR",
  dbrx: "DBRX",
  glm: "GLM",
  gpt: "GPT",
  it: "IT",
  llm: "LLM",
  lora: "LoRA",
  mllm: "MLLM",
  moe: "MoE",
  nv: "NV",
  ocr: "OCR",
  qat: "QAT",
  qa: "QA",
  rag: "RAG",
  tts: "TTS",
  vl: "VL",
  vlm: "VLM",
  vqa: "VQA",
};

const WORDS: Record<string, string> = {
  chatqa: "ChatQA",
  codegemma: "CodeGemma",
  codellama: "CodeLlama",
  codestral: "Codestral",
  deepseek: "DeepSeek",
  diffusiongemma: "DiffusionGemma",
  gemma: "Gemma",
  granite: "Granite",
  jamba: "Jamba",
  llama: "Llama",
  llama2: "Llama 2",
  llama3: "Llama 3",
  llama4: "Llama 4",
  minitron: "Minitron",
  mistral: "Mistral",
  mixtral: "Mixtral",
  nemoguard: "NemoGuard",
  nemotron: "Nemotron",
  neva: "NeVA",
  paligemma: "PaliGemma",
  palmyra: "Palmyra",
  phi: "Phi",
  qwen: "Qwen",
  recurrentgemma: "RecurrentGemma",
  starcoder: "StarCoder",
  vila: "VILA",
  yi: "Yi",
  zamba: "Zamba",
};

function titleWord(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYMS[lower]) return ACRONYMS[lower];
  if (WORDS[lower]) return WORDS[lower];
  return lower.length === 0 ? "" : `${lower[0].toUpperCase()}${lower.slice(1)}`;
}

function titleToken(token: string): string {
  const lower = token.toLowerCase();
  if (ACRONYMS[lower]) return ACRONYMS[lower];
  if (WORDS[lower]) return WORDS[lower];

  const size = /^(\d+(?:\.\d+)?)([bkm])$/.exec(lower);
  if (size) return `${size[1]}${size[2].toUpperCase()}`;

  const moeSize = /^(\d+)x(\d+(?:\.\d+)?)([bkm])$/.exec(lower);
  if (moeSize) return `${moeSize[1]}x${moeSize[2]}${moeSize[3].toUpperCase()}`;

  const active = /^a(\d+(?:\.\d+)?)([bkm])$/.exec(lower);
  if (active) return `A${active[1]}${active[2].toUpperCase()}`;

  const version = /^v(\d+(?:\.\d+)*)$/.exec(lower);
  if (version) return `V${version[1]}`;

  const mixed = /^([a-z]+)(\d+(?:\.\d+)*)([a-z]*)$/.exec(lower);
  if (mixed) {
    const base = titleWord(mixed[1]);
    const suffix = mixed[3] ? ` ${titleWord(mixed[3])}` : "";
    return `${base} ${mixed[2]}${suffix}`;
  }

  const numberWord = /^(\d+(?:\.\d+)*)([a-z]+)$/.exec(lower);
  if (numberWord) return `${numberWord[1]}${titleWord(numberWord[2])}`;

  return titleWord(lower);
}

export function displayNameForModel(id: string, catalogName?: string): string {
  if (!catalogName) return humanizeModelId(id);
  const separators = (catalogName.match(/[-_]/g) ?? []).length;
  if (separators >= 2) return humanizeModelId(id);
  return catalogName.replace(
    /\b(\d+(?:\.\d+)?)([bkm])\b/gi,
    (_match, size: string, unit: string) => `${size}${unit.toUpperCase()}`,
  );
}

export function humanizeModelId(id: string): string {
  const slash = id.indexOf("/");
  const withoutVendor = slash >= 0 ? id.slice(slash + 1) : id;
  const colon = withoutVendor.indexOf(":");
  const base = colon >= 0 ? withoutVendor.slice(0, colon) : withoutVendor;
  const tag = colon >= 0 ? withoutVendor.slice(colon + 1) : "";

  const words = base
    .replace(/[-_]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(titleToken);

  if (tag && tag !== "latest" && /^\d/.test(tag)) {
    words.push(
      ...tag
        .replace(/[-_]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map(titleToken),
    );
  }

  return words.join(" ").replace(/\s+/g, " ").trim() || id;
}
