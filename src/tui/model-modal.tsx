import React from "react";
import { Box, Text, useInput, useStdin } from "ink";

import {
  ProviderKindSchema,
  ProviderProfileSchema,
  type ModelCapabilities,
  type ModelCapabilitiesPatch,
  type ProviderKind,
  type ProviderProfile,
} from "../config/loader";
import {
  appendProviderModel,
  clearModeModelSelections,
  deleteProviderProfile,
  removeProviderModel,
  replaceProviderModels,
  saveModeReasoning,
  saveModeSelection,
  saveModelCapabilities,
  saveProviderProfile,
  saveRoleSelection,
  setProviderEnabled,
  type ConfigMode,
  type ConfigRole,
} from "../config/writer";
import { discoverLocalProviders, type DiscoveredProvider } from "../provider/discover";
import { displayNameForModel } from "../provider/model-name";
import { findMissingModels } from "../provider/model-sync";
import { refreshRuntimeMetadata } from "../provider/runtime-metadata";
import type { ProviderReferences, ProviderRouter, ProviderSummary } from "../provider/router";
import { filterFuzzy } from "./autocomplete";
import { truncateText } from "./format";
import { REASONING_LEVELS, reasoningLevelsFor, type ReasoningEffortLevel } from "./command-palette";
import { isMouseSequence } from "./mouse";
import {
  clampCursor,
  deleteCharacterAfter,
  deleteCharacterBefore,
  deleteNextWord,
  deletePreviousWord,
  insertTextAt,
  isBackspaceKey,
  isDeleteKey,
  isForwardDeleteSequence,
  isWordBackspaceKey,
  isWordBackspaceSequence,
  isWordDeleteKey,
  isWordDeleteSequence,
} from "./text-edit";
import { getTheme, type Theme } from "./theme";

const PROVIDER_KINDS = ProviderKindSchema.options;
type ModelTarget = ConfigRole | ConfigMode;
const TARGET_ORDER: ModelTarget[] = ["main", "fast", "advisor", "plan", "build", "ultrawork"];

function isModeTarget(target: ModelTarget): target is ConfigMode {
  return target === "plan" || target === "build" || target === "ultrawork";
}
const FORM_FIELDS = ["name", "kind", "baseUrl", "apiKey", "models"] as const;
type FormField = (typeof FORM_FIELDS)[number];

interface ProviderForm {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: string;
}

const EMPTY_FORM: ProviderForm = {
  name: "",
  kind: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  models: "",
};

const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  openclaude: "",
  ollama: "http://127.0.0.1:11434/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

interface PlatformPreset {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
}

const PLATFORM_PRESETS: PlatformPreset[] = [
  { id: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com" },
  { id: "openrouter", name: "OpenRouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "custom", name: "Custom provider", kind: "openai", baseUrl: "" },
];

const CUSTOM_PRESET = PLATFORM_PRESETS.find((preset) => preset.id === "custom")!;
const CUSTOM_KINDS: ProviderKind[] = ["openai", "anthropic"];
const PROVIDER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const KIND_LABELS: Record<ProviderKind, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
  openclaude: "OpenClaude",
  ollama: "Ollama",
  openrouter: "OpenRouter",
};

type InputKey = {
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind as ProviderKind] ?? kind;
}

function validateProviderName(name: string, existingNames: string[]): string | undefined {
  if (name.length === 0) return "Provider name is required.";
  if (!PROVIDER_NAME_PATTERN.test(name)) {
    return "Use letters, numbers, - and _. Start with a letter or number.";
  }
  if (existingNames.includes(name)) {
    return `Provider "${name}" already exists. Choose another name.`;
  }
  return undefined;
}

function isPlainTextInput(input: string, key: InputKey): boolean {
  return (
    !key.ctrl &&
    !key.meta &&
    !key.backspace &&
    !key.delete &&
    input.length > 0 &&
    input >= " " &&
    !input.startsWith("\x1b")
  );
}

const CAPABILITY_FIELDS = [
  "tool_calling",
  "reasoning",
  "vision",
  "structured_output",
  "temperature",
  "pdf",
  "parallel_tool_calls",
  "context_window",
  "max_input",
  "max_output",
] as const;
type CapabilityField = (typeof CAPABILITY_FIELDS)[number];

interface CapabilitiesDraft {
  tool_calling: boolean;
  reasoning: boolean;
  vision: boolean;
  structured_output: boolean;
  temperature: boolean;
  pdf: boolean;
  parallel_tool_calls: boolean;
  context_window: string;
  max_input: string;
  max_output: string;
}

const EMPTY_CAPABILITIES_DRAFT: CapabilitiesDraft = {
  tool_calling: true,
  reasoning: false,
  vision: false,
  structured_output: false,
  temperature: true,
  pdf: false,
  parallel_tool_calls: true,
  context_window: "",
  max_input: "",
  max_output: "",
};

function draftFromCapabilities(capabilities: ModelCapabilities): CapabilitiesDraft {
  return {
    tool_calling: capabilities.tool_calling,
    reasoning: capabilities.reasoning,
    vision: capabilities.vision,
    structured_output: capabilities.structured_output,
    temperature: capabilities.temperature,
    pdf: capabilities.pdf,
    parallel_tool_calls: capabilities.parallel_tool_calls,
    context_window: capabilities.context_window !== undefined ? String(capabilities.context_window) : "",
    max_input: capabilities.max_input !== undefined ? String(capabilities.max_input) : "",
    max_output: capabilities.max_output !== undefined ? String(capabilities.max_output) : "",
  };
}

const LIMIT_FIELDS = ["context_window", "max_input", "max_output"] as const;
type LimitField = (typeof LIMIT_FIELDS)[number];

function isCapabilityBoolean(field: CapabilityField): field is Exclude<CapabilityField, LimitField> {
  return !(LIMIT_FIELDS as readonly string[]).includes(field);
}

function isLimitField(field: CapabilityField): field is LimitField {
  return (LIMIT_FIELDS as readonly string[]).includes(field);
}

interface ModelEntry {
  provider: string;
  groupLabel: string;
  model: string;
  displayName: string;
  catalogName: boolean;
  vendor?: string;
  kind: ProviderKind;
  baseUrl: string;
  source: "config" | "local";
  nonChat: boolean;
}

type ProviderSyncState =
  | { state: "checking" }
  | { state: "ok"; count: number; missing: string[] }
  | { state: "error" };

const VENDOR_PRIORITY = [
  "nvidia",
  "meta",
  "deepseek-ai",
  "mistralai",
  "google",
  "openai",
  "microsoft",
  "ibm",
  "moonshotai",
  "stepfun-ai",
  "z-ai",
  "writer",
  "poolside",
  "zyphra",
  "snowflake",
  "bigcode",
  "databricks",
  "ai21labs",
  "aisingapore",
  "01-ai",
];

function vendorRank(vendor: string | undefined): number {
  if (!vendor) return VENDOR_PRIORITY.length;
  const index = VENDOR_PRIORITY.indexOf(vendor);
  return index === -1 ? VENDOR_PRIORITY.length : index;
}

const NON_CHAT_PATTERN =
  /(?:^|[/_.-])(embed\w*|rerank|reranker|retriever|nemoretriever|clip|parse|safety|guard|reward|voice|voicechat|asr|tts|stt|riva-translate|studiovoice|usdcode|usdvalidate|ai-synthetic-video-detector|deplot|kosmos|fuyu|paligemma|vila|neva|esm2|esmfold|diffusion\w*|flux\w*|bge|arctic-embed|nvclip|nemotron-parse|nemoguard|content-safety|topic-control|calibration)(?:$|[/_.-])/i;

function isNonChatModelId(id: string): boolean {
  return NON_CHAT_PATTERN.test(id);
}

interface ModelGroup {
  key: string;
  label: string;
  isLocal: boolean;
  profiles: string[];
  models: ModelEntry[];
}

type ModalView =
  | "models"
  | "providers"
  | "providerAdd"
  | "providerModels"
  | "connect"
  | "capabilities"
  | "reasoning";

type ConfirmAction =
  | { kind: "delete-provider"; provider: string; refs: ProviderReferences }
  | { kind: "delete-model"; provider: string; model: string; refs: ProviderReferences };

export interface ModelConfigModalProps {
  router: ProviderRouter;
  configPath: string;
  secretsPath: string;
  theme?: Theme;
  initialView?: "models" | "providers";
  initialTarget?: ConfigRole | ConfigMode;
  onViewChange?: (view: "models" | "providers") => void;
  onClose: () => void;
  onSaved?: (message: string) => void;
  onRoleChange?: (role: ConfigRole, provider: string, model: string) => void;
  /** Fired when the session model changes and every mode pin is dropped. */
  onSessionModelChange?: (provider: string, model: string) => void;
  onModeModelChange?: (mode: ConfigMode, provider: string, model: string) => void;
  onModeReasoningChange?: (mode: ConfigMode, reasoning: string) => void;
  reasoningEffort?: ReasoningEffortLevel;
  onReasoningChange?: (effort: ReasoningEffortLevel) => void;
  height?: number;
}

function profileFromForm(form: ProviderForm, custom = false): ProviderProfile {
  return ProviderProfileSchema.parse({
    kind: form.kind,
    base_url: form.baseUrl.trim(),
    models: form.models
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    // Custom endpoints should not inherit the built-in catalog for their protocol.
    ...(custom ? { catalog_provider: "custom" } : {}),
    enabled: true,
  });
}

function describeError(cause: unknown): string {
  if (cause && typeof cause === "object" && "issues" in cause) {
    const issues = (cause as { issues?: Array<{ path?: Array<string | number>; message?: string }> }).issues ?? [];
    return issues
      .map((issue) => `${(issue.path ?? []).join(".") || "form"}: ${issue.message ?? "invalid value"}`)
      .join("; ");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function ModelConfigModal(props: ModelConfigModalProps) {
  const {
    router,
    configPath,
    secretsPath,
    theme = getTheme("tokyonight"),
    initialView,
    initialTarget,
    onViewChange,
    onClose,
    onSaved,
    onRoleChange,
    onSessionModelChange,
    onModeModelChange,
    onModeReasoningChange,
    reasoningEffort = "default",
    onReasoningChange,
    height = 24,
  } = props;
  const compact = (process.stdout.columns ?? 80) < 72 || height < 20;
  const veryCompact = height < 10;

  const [view, setView] = React.useState<ModalView>(
    initialView === "providers" ? "providers" : "models",
  );
  const [targetRole, setTargetRole] = React.useState<ModelTarget>(initialTarget ?? "main");
  const [query, setQuery] = React.useState("");
  const [queryCursor, setQueryCursor] = React.useState(0);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [showNonChat, setShowNonChat] = React.useState(false);
  const [discovered, setDiscovered] = React.useState<DiscoveredProvider[]>([]);
  const [discovering, setDiscovering] = React.useState(true);
  const [reasoningIndex, setReasoningIndex] = React.useState(0);
  const [form, setForm] = React.useState<ProviderForm>(EMPTY_FORM);
  const [field, setField] = React.useState(0);
  const [formCursor, setFormCursor] = React.useState(0);
  const [formMode, setFormMode] = React.useState<"custom" | "preset" | "edit">("preset");
  const [formReturnView, setFormReturnView] = React.useState<"models" | "providers" | "providerAdd">(
    "providers",
  );
  const [editingProvider, setEditingProvider] = React.useState<string | undefined>();
  const [nameNotice, setNameNotice] = React.useState<string | undefined>();
  const [providerIndex, setProviderIndex] = React.useState(0);
  const [providerAddIndex, setProviderAddIndex] = React.useState(0);
  const [manageProvider, setManageProvider] = React.useState<string | undefined>();
  const [manageModelIndex, setManageModelIndex] = React.useState(0);
  const [modelInputActive, setModelInputActive] = React.useState(false);
  const [modelInput, setModelInput] = React.useState("");
  const [modelInputCursor, setModelInputCursor] = React.useState(0);
  const [remoteSync, setRemoteSync] = React.useState<Record<string, ProviderSyncState>>({});
  const [confirmAction, setConfirmAction] = React.useState<ConfirmAction | undefined>();
  const [status, setStatus] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  const [capTarget, setCapTarget] = React.useState<{ provider: string; model: string } | undefined>();
  const [capReturnView, setCapReturnView] = React.useState<"models" | "providerModels">("models");
  const [capField, setCapField] = React.useState(0);
  const [capDraft, setCapDraft] = React.useState<CapabilitiesDraft>(EMPTY_CAPABILITIES_DRAFT);
  const [capOverride, setCapOverride] = React.useState(false);
  const [capSource, setCapSource] = React.useState<string>("default");
  const didSelectTarget = React.useRef(false);
  const rawSequence = React.useRef("");
  const { stdin } = useStdin();
  const [, forceRender] = React.useReducer((value: number) => value + 1, 0);

  const providerSnapshot = router.listProviders();
  const providerSignature = providerSnapshot
    .map((provider) =>
      [
        provider.name,
        provider.kind,
        provider.baseUrl,
        provider.enabled,
        provider.hasApiKey,
        provider.models.join(","),
      ].join("\u0000"),
    )
    .join("\u0001");
  const providers = React.useMemo(
    () => providerSnapshot,
    [providerSignature, router],
  );
  const visibleFormFields: readonly FormField[] =
    formMode === "edit" ? FORM_FIELDS.filter((name) => name !== "models") : FORM_FIELDS;
  const activeFormField: FormField = visibleFormFields[field] ?? visibleFormFields[0] ?? "name";
  const customProvider = formMode === "custom";
  const kindChoices = customProvider ? CUSTOM_KINDS : PROVIDER_KINDS;
  const liveNameError =
    formMode !== "edit" && form.name.length > 0
      ? validateProviderName(
          form.name,
          providers
            .filter((provider) => provider.name !== editingProvider)
            .map((provider) => provider.name),
        )
      : undefined;
  const hasQuery = query.trim().length > 0;

  const runtimeForProvider = React.useCallback(
    (provider: ProviderSummary): DiscoveredProvider | undefined =>
      discovered.find((entry) => entry.id === provider.name) ??
      discovered.find((entry) => entry.baseUrl === provider.baseUrl) ??
      (provider.kind === "ollama"
        ? discovered.find((entry) => entry.kind === "ollama")
        : undefined),
    [discovered],
  );

  const missingLocalModels = React.useMemo(() => {
    const result = new Map<string, string[]>();
    for (const provider of providers) {
      const runtime = runtimeForProvider(provider);
      if (!runtime) continue;
      const missing = findMissingModels(provider.models, runtime.models);
      if (missing.length > 0) result.set(provider.name, missing);
    }
    return result;
  }, [providers, runtimeForProvider]);

  const levelOptions = (target: ModelTarget) => {
    if (isModeTarget(target)) return reasoningLevelsFor(router.reasoningOptionsForMode(target));
    if (target === "main") return reasoningLevelsFor(router.reasoningOptionsForRole("main"));
    return REASONING_LEVELS;
  };

  const modelGroups = React.useMemo<ModelGroup[]>(() => {
    const groups = new Map<string, ModelGroup>();
    const enabledProviders = providers.filter((provider) => provider.enabled);

    const ensureGroup = (key: string, label: string, isLocal: boolean): ModelGroup => {
      const existing = groups.get(key);
      if (existing) return existing;
      const group: ModelGroup = { key, label, isLocal, profiles: [], models: [] };
      groups.set(key, group);
      return group;
    };
    const makeEntry = (
      provider: string,
      groupLabel: string,
      model: string,
      kind: ProviderKind,
      baseUrl: string,
      source: "config" | "local",
    ): ModelEntry => {
      const catalog = router.catalogModelFor(provider, model);
      const slash = model.indexOf("/");
      return {
        provider,
        groupLabel,
        model,
        displayName: displayNameForModel(model, catalog?.name),
        catalogName: Boolean(catalog?.name),
        vendor: catalog?.family ?? (slash > 0 ? model.slice(0, slash) : undefined),
        kind,
        baseUrl,
        source,
        nonChat: isNonChatModelId(model),
      };
    };
    const addModel = (group: ModelGroup, entry: ModelEntry): void => {
      if (
        group.models.some(
          (existing) => existing.provider === entry.provider && existing.model === entry.model,
        )
      ) {
        return;
      }
      group.models.push(entry);
    };

    for (const provider of enabledProviders) {
      const runtime = runtimeForProvider(provider);
      const installed = runtime ? new Set(runtime.models) : undefined;
      const isLocal = Boolean(runtime) || provider.kind === "ollama";
      const key = provider.kind === "ollama" ? "ollama" : (runtime?.id ?? provider.name);
      const label = provider.kind === "ollama" ? "Ollama" : (runtime?.name ?? provider.name);
      const group = ensureGroup(key, label, isLocal);
      if (!group.profiles.includes(provider.name)) group.profiles.push(provider.name);
      for (const model of provider.models) {
        if (installed && !installed.has(model)) continue;
        addModel(
          group,
          makeEntry(
            provider.name,
            group.label,
            model,
            provider.kind as ProviderKind,
            provider.baseUrl,
            "config",
          ),
        );
      }
    }

    for (const runtime of discovered) {
      const configuredMatch =
        providers.find((provider) => provider.name === runtime.id) ??
        providers.find((provider) => provider.baseUrl === runtime.baseUrl) ??
        (runtime.kind === "ollama"
          ? providers.find((provider) => provider.kind === "ollama")
          : undefined);
      if (configuredMatch && !configuredMatch.enabled) continue;
      const matchingProvider = configuredMatch?.enabled ? configuredMatch : undefined;
      const key = runtime.kind === "ollama" ? "ollama" : runtime.id;
      const label = runtime.kind === "ollama" ? "Ollama" : runtime.name;
      const group = ensureGroup(key, label, true);
      const providerName = matchingProvider?.name ?? runtime.id;
      if (!group.profiles.includes(providerName)) group.profiles.push(providerName);
      for (const model of runtime.models) {
        addModel(
          group,
          makeEntry(
            providerName,
            group.label,
            model,
            runtime.kind,
            runtime.baseUrl,
            matchingProvider ? "config" : "local",
          ),
        );
      }
    }

    for (const group of groups.values()) {
      group.models.sort((first, second) => {
        const knownCompare = (first.catalogName ? 0 : 1) - (second.catalogName ? 0 : 1);
        if (knownCompare !== 0) return knownCompare;
        const rankCompare = vendorRank(first.vendor) - vendorRank(second.vendor);
        if (rankCompare !== 0) return rankCompare;
        const vendorCompare = (first.vendor ?? "").localeCompare(second.vendor ?? "");
        if (vendorCompare !== 0) return vendorCompare;
        const nameCompare = (first.displayName ?? first.model).localeCompare(
          second.displayName ?? second.model,
        );
        return nameCompare !== 0 ? nameCompare : first.model.localeCompare(second.model);
      });
    }

    return [...groups.values()].sort((first, second) => {
      if (first.key === "ollama") return -1;
      if (second.key === "ollama") return 1;
      if (first.isLocal !== second.isLocal) return first.isLocal ? -1 : 1;
      return first.label.localeCompare(second.label);
    });
  }, [discovered, providers, router]);

  const flatModels = React.useMemo(
    () => modelGroups.flatMap((group) => group.models),
    [modelGroups],
  );
  const visibleModels = React.useMemo(
    () => (showNonChat ? flatModels : flatModels.filter((entry) => !entry.nonChat)),
    [flatModels, showNonChat],
  );
  const hiddenNonChatCount = flatModels.length - visibleModels.length;
  const derivedNameCount = flatModels.filter((entry) => !entry.catalogName).length;

  const filteredModels = React.useMemo(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return visibleModels;
    return filterFuzzy(
      trimmed,
      visibleModels,
      (entry) =>
        `${entry.displayName} ${entry.model} ${entry.groupLabel} ${entry.provider}`,
      Math.max(30, visibleModels.length),
    ).map((entry) => entry.item);
  }, [visibleModels, query]);

  const MODEL_WINDOW = veryCompact
    ? Math.max(1, height - 4)
    : compact
      ? Math.max(3, height - 10)
      : 12;
  const clampedModelIndex = Math.max(0, Math.min(filteredModels.length - 1, selectedIndex));
  const windowStart = Math.max(
    0,
    Math.min(
      Math.max(0, filteredModels.length - MODEL_WINDOW),
      clampedModelIndex - Math.floor(MODEL_WINDOW / 2),
    ),
  );
  const windowEnd = Math.min(filteredModels.length, windowStart + MODEL_WINDOW);
  const windowModels = filteredModels.slice(windowStart, windowEnd);
  const windowModelSet = new Set(windowModels);
  const filteredOrder = new Map(filteredModels.map((entry, index) => [entry, index]));
  const windowGroups = modelGroups
    .map((group) => ({
      ...group,
      models: group.models
        .filter((entry) => windowModelSet.has(entry))
        .sort((first, second) =>
          hasQuery
            ? (filteredOrder.get(first) ?? 0) - (filteredOrder.get(second) ?? 0)
            : 0,
        ),
    }))
    .filter((group) => group.models.length > 0);
  const emptyGroups = modelGroups.filter((group) => group.models.length === 0);
  const selectedModel = filteredModels[clampedModelIndex];

  React.useEffect(() => {
    if (didSelectTarget.current || view !== "models" || hasQuery) return;
    const ref = isModeTarget(targetRole)
      ? router.getModeModel(targetRole)
      : router.getRole(targetRole);
    if (!ref) return;
    const index = filteredModels.findIndex(
      (entry) => entry.provider === ref.provider && entry.model === ref.model,
    );
    if (index >= 0) {
      setSelectedIndex(index);
      didSelectTarget.current = true;
    }
  }, [filteredModels, hasQuery, router, targetRole, view]);

  const clampedProviderIndex = Math.max(0, Math.min(providers.length - 1, providerIndex));
  const selectedProvider = providers[clampedProviderIndex];
  const providerWindow = compact ? Math.max(1, height - 4) : 10;
  const providerStart = Math.max(
    0,
    Math.min(
      Math.max(0, providers.length - providerWindow),
      clampedProviderIndex - Math.floor(Math.min(providerWindow, providers.length) / 2),
    ),
  );
  const providerEnd = Math.min(providers.length, providerStart + providerWindow);
  const visibleProviders = providers.slice(providerStart, providerEnd);
  const clampedProviderAddIndex = Math.max(
    0,
    Math.min(PLATFORM_PRESETS.length - 1, providerAddIndex),
  );
  const managedProfile = manageProvider ? router.getProviderProfile(manageProvider) : undefined;
  const managedModels = managedProfile?.models ?? [];
  const clampedManagedModelIndex = Math.max(0, Math.min(managedModels.length - 1, manageModelIndex));
  const managedWindow = compact ? Math.max(1, height - 5) : 12;
  const managedStart = Math.max(
    0,
    Math.min(
      Math.max(0, managedModels.length - managedWindow),
      clampedManagedModelIndex - Math.floor(Math.min(managedWindow, managedModels.length) / 2),
    ),
  );
  const managedEnd = Math.min(managedModels.length, managedStart + managedWindow);
  const managedVisible = managedModels.slice(managedStart, managedEnd);

  React.useEffect(() => {
    let cancelled = false;
    setDiscovering(true);
    discoverLocalProviders()
      .then((providers) => {
        if (cancelled) return;
        // Reset before the state update so the selection effect sees it on the
        // render that adds the discovered models.
        didSelectTarget.current = false;
        setDiscovered(providers);
        setDiscovering(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const handleData = (data: Buffer | string): void => {
      rawSequence.current = data.toString();
    };
    stdin.on("data", handleData);
    return () => {
      stdin.off("data", handleData);
    };
  }, [stdin]);

  const openConnect = (
    preset: PlatformPreset = CUSTOM_PRESET,
    returnView: "providers" | "providerAdd" = "providers",
  ): void => {
    const custom = preset.id === "custom";
    const nameTaken = !custom && router.listProviders().some((provider) => provider.name === preset.id);
    const nextForm = {
      ...EMPTY_FORM,
      name: custom || nameTaken ? "" : preset.id,
      kind: custom ? "openai" : preset.kind,
      baseUrl: custom ? "" : preset.baseUrl,
    };
    setForm(nextForm);
    setFormMode(custom ? "custom" : "preset");
    setEditingProvider(undefined);
    setFormReturnView(returnView);
    setNameNotice(undefined);
    setField(0);
    setFormCursor(nextForm.name.length);
    setError(undefined);
    setStatus(undefined);
    setView("connect");
  };

  const openEditProvider = (name: string): void => {
    const profile = router.getProviderProfile(name);
    if (!profile) {
      setError(`Unknown provider "${name}".`);
      return;
    }
    setForm({
      name,
      kind: profile.kind,
      baseUrl: profile.base_url,
      apiKey: "",
      models: profile.models.join(", "),
    });
    setFormMode("edit");
    setEditingProvider(name);
    setFormReturnView("providers");
    setNameNotice(undefined);
    setField(0);
    setFormCursor(name.length);
    setError(undefined);
    setStatus(undefined);
    setView("connect");
  };

  const openModelsView = (): void => {
    setView("models");
    onViewChange?.("models");
    didSelectTarget.current = false;
    setQuery("");
    setQueryCursor(0);
    setSelectedIndex(0);
    setError(undefined);
  };

  const openProvidersView = (focus?: string): void => {
    setView("providers");
    onViewChange?.("providers");
    if (focus) {
      setProviderIndex(Math.max(0, providers.findIndex((provider) => provider.name === focus)));
    }
    setError(undefined);
  };

  const openProviderAdd = (): void => {
    setView("providerAdd");
    setProviderAddIndex(0);
    setError(undefined);
  };

  const openProviderModels = (name: string): void => {
    setManageProvider(name);
    setManageModelIndex(0);
    setModelInputActive(false);
    setModelInput("");
    setModelInputCursor(0);
    setError(undefined);
    setStatus(undefined);
    setView("providerModels");
  };

  const registerDiscovered = async (entry: ModelEntry): Promise<void> => {
    try {
      const existing = router.listProviders().find((provider) => provider.name === entry.provider);
      if (existing && !existing.enabled) {
        setError(`Provider "${entry.provider}" is disabled. Enable it in /connect first.`);
        return;
      }
      if (!existing) {
        const found = discovered.find((provider) => provider.id === entry.provider);
        const profile = ProviderProfileSchema.parse({
          kind: entry.kind,
          base_url: entry.baseUrl,
          models: found?.models ?? [entry.model],
          // Local OpenAI-compatible runtimes should not inherit the hosted catalog.
          catalog_provider: "local",
          enabled: true,
        });
        await saveProviderProfile({
          configPath,
          secretsPath,
          name: entry.provider,
          profile,
        });
        router.addProvider(entry.provider, profile);
      }
      await assignModel(entry.provider, entry.model);
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const assignModel = async (provider: string, model: string): Promise<void> => {
    try {
      const configured = router
        .listAllConfiguredModels()
        .some((entry) => entry.provider === provider && entry.model === model);
      if (!configured) {
        await appendProviderModel(configPath, provider, model);
        router.addModel(provider, model);
      }

      if (isModeTarget(targetRole)) {
        router.setModeModel(targetRole, provider, model);
        await saveModeSelection(configPath, targetRole, provider, model);
        onModeModelChange?.(targetRole, provider, model);
      } else {
        router.setRole(targetRole, provider, model);
        await saveRoleSelection(configPath, targetRole, provider, model);
        onRoleChange?.(targetRole, provider, model);
        // The main model is the session model: drop per-mode pins so a model
        // change applies everywhere instead of staying tied to one mode.
        if (targetRole === "main") {
          router.clearModeModels();
          await clearModeModelSelections(configPath);
          onSessionModelChange?.(provider, model);
        }
      }

      setStatus(
        targetRole === "main"
          ? `all modes now use ${provider} / ${model}`
          : `${targetRole} now uses ${provider} / ${model}`,
      );
      setError(undefined);
      didSelectTarget.current = false;
      setQuery("");
      setQueryCursor(0);
      setSelectedIndex(0);
      forceRender();

      const levels = levelOptions(targetRole);
      if ((targetRole === "main" || isModeTarget(targetRole)) && levels.length > 1) {
        const current = isModeTarget(targetRole) ? router.getModeReasoning(targetRole) : reasoningEffort;
        setReasoningIndex(Math.max(0, levels.findIndex((level) => level.id === current)));
        setView("reasoning");
      } else {
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const openCapabilities = (
    provider: string,
    model: string,
    returnView: "models" | "providerModels" = "models",
  ): void => {
    try {
      const capabilities = router.capabilitiesFor(provider, model);
      setCapTarget({ provider, model });
      setCapReturnView(returnView);
      setCapDraft(draftFromCapabilities(capabilities));
      setCapSource(capabilities.source ?? "default");
      setCapOverride(Boolean(router.capabilitiesOverrideFor(provider, model)));
      setCapField(0);
      setStatus(undefined);
      setError(undefined);
      setView("capabilities");

      const profile = router.getProviderProfile(provider);
      if (profile && profile.kind !== "anthropic") {
        void refreshRuntimeMetadata(profile)
          .then(() => {
            router.refresh();
            const refreshed = router.capabilitiesFor(provider, model);
            setCapDraft(draftFromCapabilities(refreshed));
            setCapSource(refreshed.source ?? "default");
            forceRender();
          })
          .catch(() => undefined);
      }
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const saveCapabilities = async (): Promise<void> => {
    if (!capTarget) return;
    const patch: ModelCapabilitiesPatch = {
      tool_calling: capDraft.tool_calling,
      reasoning: capDraft.reasoning,
      vision: capDraft.vision,
      structured_output: capDraft.structured_output,
      temperature: capDraft.temperature,
      pdf: capDraft.pdf,
      parallel_tool_calls: capDraft.parallel_tool_calls,
    };
    const contextWindow = Number.parseInt(capDraft.context_window, 10);
    if (Number.isFinite(contextWindow) && contextWindow > 0) patch.context_window = contextWindow;
    const maxInput = Number.parseInt(capDraft.max_input, 10);
    if (Number.isFinite(maxInput) && maxInput > 0) patch.max_input = maxInput;
    const maxOutput = Number.parseInt(capDraft.max_output, 10);
    if (Number.isFinite(maxOutput) && maxOutput > 0) patch.max_output = maxOutput;

    try {
      await saveModelCapabilities(configPath, capTarget.provider, capTarget.model, patch);
      router.setModelCapabilities(capTarget.provider, capTarget.model, patch);
      setCapOverride(true);
      setStatus(`saved capabilities for ${capTarget.model}`);
      setError(undefined);
      onSaved?.(`capabilities saved for ${capTarget.model}`);
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const resetCapabilities = async (): Promise<void> => {
    if (!capTarget) return;
    try {
      await saveModelCapabilities(configPath, capTarget.provider, capTarget.model, undefined);
      router.setModelCapabilities(capTarget.provider, capTarget.model, undefined);
      const capabilities = router.capabilitiesFor(capTarget.provider, capTarget.model);
      setCapDraft(draftFromCapabilities(capabilities));
      setCapSource(capabilities.source ?? "default");
      setCapOverride(false);
      setStatus("reset to automatic capabilities");
      setError(undefined);
      onSaved?.(`capabilities reset for ${capTarget.model}`);
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  const submitProvider = async (skipTest: boolean): Promise<void> => {
    const editing = Boolean(editingProvider);
    const name = editingProvider ?? form.name;
    if (!editing) {
      const nameError = validateProviderName(
        name,
        router.listProviders().map((entry) => entry.name),
      );
      if (nameError) {
        setError(nameError);
        return;
      }
    }

    let parsed: ProviderProfile;
    try {
      parsed = profileFromForm(form, formMode === "custom");
    } catch (cause) {
      setError(describeError(cause));
      return;
    }

    const existingProfile = editing ? router.getProviderProfile(name) : undefined;
    if (editing && !existingProfile) {
      setError(`Unknown provider "${name}".`);
      return;
    }

    const baseProfile: ProviderProfile = existingProfile
      ? {
          ...existingProfile,
          ...parsed,
          models: existingProfile.models,
          enabled: existingProfile.enabled,
        }
      : parsed;
    const apiKey = form.apiKey.trim();
    const candidate: ProviderProfile = {
      ...baseProfile,
      api_key: apiKey.length > 0 ? apiKey : existingProfile?.api_key,
    };

    setBusy(true);
    setError(undefined);
    setStatus(skipTest ? "Saving provider..." : "Testing provider...");

    try {
      let remoteModels: string[] = [];
      if (!skipTest) {
        remoteModels = await router.testProvider(candidate);
      }
      const models =
        baseProfile.models.length > 0
          ? [...new Set(baseProfile.models)]
          : [...new Set(remoteModels)];
      if (existingProfile) {
        const removedModels = existingProfile.models.filter((model) => !models.includes(model));
        const usedRefs = removedModels.flatMap((model) => {
          const refs = router.referencesForModel(name, model);
          return [...refs.roles, ...refs.modes];
        });
        if (usedRefs.length > 0) {
          setError(
            `Models used by ${[...new Set(usedRefs)].join(", ")} cannot be removed. Reassign those first.`,
          );
          setStatus(undefined);
          return;
        }
      }
      const runtimeProfile: ProviderProfile = {
        ...candidate,
        models,
      };

      await saveProviderProfile({
        configPath,
        secretsPath,
        name,
        profile: runtimeProfile,
        apiKey,
      });
      router.addProvider(name, runtimeProfile);

      if (existingProfile) {
        const removedModels = existingProfile.models.filter((model) => !models.includes(model));
        for (const removed of removedModels) {
          await removeProviderModel(configPath, name, removed);
          router.removeModel(name, removed);
        }
      }

      if (!editing && !router.getRole("main") && models.length > 0) {
        router.setRole("main", name, models[0]);
        await saveRoleSelection(configPath, "main", name, models[0]);
        onRoleChange?.("main", name, models[0]);
      }

      setStatus(
        models.length > 0
          ? `${editing ? "Updated" : "Connected"} ${name} with ${models.length} model(s).`
          : `${editing ? "Updated" : "Saved"} ${name}. Add models later if the provider lists none.`,
      );
      setForm(EMPTY_FORM);
      setField(0);
      setFormCursor(0);
      setFormMode("preset");
      setEditingProvider(undefined);
      setNameNotice(undefined);
      setView("providers");
      setProviderIndex(
        Math.max(
          0,
          router.listProviders().findIndex((provider) => provider.name === name),
        ),
      );
      forceRender();
      onSaved?.(`${editing ? "updated" : "connected"} ${name}`);
    } catch (cause) {
      setError(describeError(cause));
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  const cycleTarget = (): void => {
    const index = TARGET_ORDER.indexOf(targetRole);
    const next = TARGET_ORDER[(index + 1) % TARGET_ORDER.length];
    setTargetRole(next);
    const ref = isModeTarget(next) ? router.getModeModel(next) : router.getRole(next);
    if (ref) {
      const modelIndex = filteredModels.findIndex(
        (entry) => entry.provider === ref.provider && entry.model === ref.model,
      );
      if (modelIndex >= 0) setSelectedIndex(modelIndex);
    }
    didSelectTarget.current = true;
  };

  const clearSearch = (): void => {
    setQuery("");
    setQueryCursor(0);
    setSelectedIndex(0);
  };

  const moveFormField = (delta: number): void => {
    const nextIndex = (field + delta + visibleFormFields.length) % visibleFormFields.length;
    const nextField = visibleFormFields[nextIndex] ?? "name";
    setField(nextIndex);
    setFormCursor(form[nextField].length);
  };

  const assignSelected = (): void => {
    const entry = filteredModels[clampedModelIndex];
    if (!entry) return;
    if (entry.source === "local") {
      void registerDiscovered(entry);
    } else {
      void assignModel(entry.provider, entry.model);
    }
  };

  const toggleProvider = async (name: string, enabled: boolean): Promise<void> => {
    if (!enabled) {
      const refs = router.referencesForProvider(name);
      const used = [...refs.roles, ...refs.modes];
      if (used.length > 0) {
        setError(
          `Provider "${name}" is used by ${used.join(", ")}. Reassign those first or delete the provider.`,
        );
        return;
      }
    }
    setBusy(true);
    setError(undefined);
    try {
      await setProviderEnabled(configPath, name, enabled);
      router.setProviderEnabled(name, enabled);
      setStatus(`${name} ${enabled ? "enabled" : "disabled"}.`);
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const requestDeleteProvider = (name: string): void => {
    setConfirmAction({
      kind: "delete-provider",
      provider: name,
      refs: router.referencesForProvider(name),
    });
  };

  const requestDeleteModel = (provider: string, model: string): void => {
    setConfirmAction({
      kind: "delete-model",
      provider,
      model,
      refs: router.referencesForModel(provider, model),
    });
  };

  const executeConfirm = async (): Promise<void> => {
    if (!confirmAction) return;
    const action = confirmAction;
    setBusy(true);
    setError(undefined);
    try {
      if (action.kind === "delete-provider") {
        await deleteProviderProfile(configPath, secretsPath, action.provider);
        router.removeProvider(action.provider);
        setStatus(`Deleted provider ${action.provider}.`);
        setConfirmAction(undefined);
        setProviderIndex(0);
        setView("providers");
      } else {
        await removeProviderModel(configPath, action.provider, action.model);
        router.removeModel(action.provider, action.model);
        setStatus(`Deleted model ${action.model} from ${action.provider}.`);
        setConfirmAction(undefined);
        setManageModelIndex(0);
        setView("providerModels");
      }
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const addManagedModel = async (): Promise<void> => {
    const model = modelInput.trim();
    if (!manageProvider || model.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      await appendProviderModel(configPath, manageProvider, model);
      router.addModel(manageProvider, model);
      setStatus(`Added ${model} to ${manageProvider}.`);
      setModelInput("");
      setModelInputCursor(0);
      setModelInputActive(false);
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const refreshManagedModels = async (): Promise<void> => {
    if (!manageProvider) return;
    const profile = router.getProviderProfile(manageProvider);
    if (!profile) return;
    setBusy(true);
    setError(undefined);
    setStatus("Fetching models...");
    try {
      const models = [...new Set(await router.testProvider(profile))];
      if (models.length === 0) {
        setError("Provider returned no models. Existing list kept.");
        setStatus(undefined);
        return;
      }
      const added = models.filter((model) => !profile.models.includes(model));
      const removed = profile.models.filter((model) => !models.includes(model));
      const usedRefs = removed.flatMap((model) => {
        const refs = router.referencesForModel(manageProvider, model);
        return [...refs.roles, ...refs.modes];
      });
      if (usedRefs.length > 0) {
        setError(
          `Refresh would remove models used by ${[...new Set(usedRefs)].join(", ")}. Reassign those first.`,
        );
        setStatus(undefined);
        return;
      }
      await replaceProviderModels(configPath, manageProvider, models);
      router.setProviderModels(manageProvider, models);
      setRemoteSync((previous) => ({
        ...previous,
        [manageProvider]: { state: "ok", count: models.length, missing: [] },
      }));
      setStatus(
        `Refreshed ${manageProvider}: ${models.length} model(s), ${added.length} new, ${removed.length} removed.`,
      );
      setManageModelIndex(0);
      forceRender();
    } catch (cause) {
      setError(describeError(cause));
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    const raw = rawSequence.current;
    rawSequence.current = "";
    if (isMouseSequence(raw) || isMouseSequence(input)) return;
    const wordBackspace = isWordBackspaceKey(key, input) || isWordBackspaceSequence(raw);
    const wordDelete = isWordDeleteKey(key, input) || isWordDeleteSequence(raw);
    const forwardDelete = isForwardDeleteSequence(raw) && !wordDelete;

    if (busy) {
      if (key.escape) onClose();
      return;
    }

    if (confirmAction) {
      if (key.escape) {
        setConfirmAction(undefined);
        return;
      }
      if (key.return) {
        void executeConfirm();
        return;
      }
      return;
    }

    if (view === "reasoning") {
      const levels = levelOptions(targetRole);
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setReasoningIndex((value) => (value > 0 ? value - 1 : Math.max(0, levels.length - 1)));
        return;
      }
      if (key.downArrow) {
        setReasoningIndex((value) => (value < levels.length - 1 ? value + 1 : 0));
        return;
      }
      if (key.return) {
        const level = levels[reasoningIndex];
        if (level) {
          if (isModeTarget(targetRole)) onModeReasoningChange?.(targetRole, level.id);
          else onReasoningChange?.(level.id);
        }
        onClose();
      }
      return;
    }

    if (view === "models") {
      const maxIndex = Math.max(0, filteredModels.length - 1);
      if (key.escape) {
        if (query.length > 0) clearSearch();
        else onClose();
        return;
      }
      if (key.ctrl && input === "a") {
        setShowNonChat((value) => !value);
        setSelectedIndex(0);
        return;
      }
      if (key.ctrl && input === "u") {
        clearSearch();
        return;
      }
      if (key.ctrl && input === "r") {
        cycleTarget();
        return;
      }
      if (key.ctrl && input === "e") {
        if (selectedModel) openCapabilities(selectedModel.provider, selectedModel.model, "models");
        return;
      }
      if (key.tab) {
        openProvidersView();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((value) => (value > 0 ? value - 1 : maxIndex));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((value) => (value < maxIndex ? value + 1 : 0));
        return;
      }
      if (key.return) {
        assignSelected();
        return;
      }
      if (wordBackspace) {
        const next = deletePreviousWord(query, queryCursor);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      if (wordDelete) {
        const next = deleteNextWord(query, queryCursor);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      if (forwardDelete) {
        const next = deleteCharacterAfter(query, queryCursor);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      if (isBackspaceKey(key, input)) {
        const next = deleteCharacterBefore(query, queryCursor);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      if (isDeleteKey(key, input)) {
        const next = deleteCharacterAfter(query, queryCursor);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      if (key.leftArrow) {
        setQueryCursor((value) => Math.max(0, value - 1));
        return;
      }
      if (key.rightArrow) {
        setQueryCursor((value) => Math.min(query.length, value + 1));
        return;
      }
      if (isPlainTextInput(input, key)) {
        if (input === "/" && query.length === 0) return;
        const next = insertTextAt(query, queryCursor, input);
        setQuery(next.nextText);
        setQueryCursor(next.nextCursor);
        setSelectedIndex(0);
        return;
      }
      return;
    }

    if (view === "providers") {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.tab) {
        openModelsView();
        return;
      }
      if (input === "a") {
        openProviderAdd();
        return;
      }
      if (input === "e" || key.return) {
        if (selectedProvider) openEditProvider(selectedProvider.name);
        return;
      }
      if (input === "t") {
        if (selectedProvider) {
          void toggleProvider(selectedProvider.name, !selectedProvider.enabled);
        }
        return;
      }
      if (input === "d") {
        if (selectedProvider) requestDeleteProvider(selectedProvider.name);
        return;
      }
      if (input === "m") {
        if (selectedProvider) openProviderModels(selectedProvider.name);
        return;
      }
      if (key.upArrow) {
        setProviderIndex((value) =>
          value > 0 ? value - 1 : Math.max(0, providers.length - 1),
        );
        return;
      }
      if (key.downArrow) {
        setProviderIndex((value) => (value < providers.length - 1 ? value + 1 : 0));
        return;
      }
      return;
    }

    if (view === "providerAdd") {
      if (key.escape) {
        openProvidersView();
        return;
      }
      if (key.upArrow) {
        setProviderAddIndex((value) =>
          value > 0 ? value - 1 : Math.max(0, PLATFORM_PRESETS.length - 1),
        );
        return;
      }
      if (key.downArrow) {
        setProviderAddIndex((value) =>
          value < PLATFORM_PRESETS.length - 1 ? value + 1 : 0,
        );
        return;
      }
      if (key.return) {
        const preset = PLATFORM_PRESETS[clampedProviderAddIndex];
        if (preset) openConnect(preset, "providerAdd");
        return;
      }
      return;
    }

    if (view === "providerModels") {
      if (modelInputActive) {
        if (key.escape) {
          setModelInputActive(false);
          setModelInput("");
          setModelInputCursor(0);
          return;
        }
        if (key.return) {
          void addManagedModel();
          return;
        }
        if (key.ctrl && input === "u") {
          setModelInput("");
          setModelInputCursor(0);
          return;
        }
        if (wordBackspace) {
          const next = deletePreviousWord(modelInput, modelInputCursor);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        if (wordDelete) {
          const next = deleteNextWord(modelInput, modelInputCursor);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        if (forwardDelete) {
          const next = deleteCharacterAfter(modelInput, modelInputCursor);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        if (isBackspaceKey(key, input)) {
          const next = deleteCharacterBefore(modelInput, modelInputCursor);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        if (isDeleteKey(key, input)) {
          const next = deleteCharacterAfter(modelInput, modelInputCursor);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        if (key.leftArrow) {
          setModelInputCursor((value) => Math.max(0, value - 1));
          return;
        }
        if (key.rightArrow) {
          setModelInputCursor((value) => Math.min(modelInput.length, value + 1));
          return;
        }
        if (isPlainTextInput(input, key)) {
          const next = insertTextAt(modelInput, modelInputCursor, input);
          setModelInput(next.nextText);
          setModelInputCursor(next.nextCursor);
          return;
        }
        return;
      }

      if (key.escape) {
        openProvidersView(manageProvider);
        return;
      }
      if (input === "a") {
        setModelInputActive(true);
        setModelInput("");
        setModelInputCursor(0);
        return;
      }
      if (input === "r") {
        void refreshManagedModels();
        return;
      }
      if (input === "d") {
        const model = managedModels[clampedManagedModelIndex];
        if (manageProvider && model) requestDeleteModel(manageProvider, model);
        return;
      }
      if ((key.ctrl && input === "e") || key.return) {
        const model = managedModels[clampedManagedModelIndex];
        if (manageProvider && model) openCapabilities(manageProvider, model, "providerModels");
        return;
      }
      if (key.upArrow) {
        const max = Math.max(0, managedModels.length - 1);
        setManageModelIndex((value) => (value > 0 ? value - 1 : max));
        return;
      }
      if (key.downArrow) {
        setManageModelIndex((value) =>
          value < managedModels.length - 1 ? value + 1 : 0,
        );
        return;
      }
      return;
    }

    if (view === "capabilities") {
      if (key.escape) {
        setView(capReturnView);
        setError(undefined);
        setStatus(undefined);
        return;
      }
      if (input === "s") {
        void saveCapabilities();
        return;
      }
      if (input === "r") {
        void resetCapabilities();
        return;
      }
      if (key.upArrow) {
        setCapField((value) => (value > 0 ? value - 1 : CAPABILITY_FIELDS.length - 1));
        return;
      }
      if (key.downArrow) {
        setCapField((value) => (value + 1) % CAPABILITY_FIELDS.length);
        return;
      }

      const fieldName: CapabilityField = CAPABILITY_FIELDS[capField] ?? "tool_calling";
      if (isCapabilityBoolean(fieldName)) {
        if (key.return || input === " ") {
          setCapDraft((previous) => ({ ...previous, [fieldName]: !previous[fieldName] }));
        }
        return;
      }

      const limitField = isLimitField(fieldName) ? fieldName : "context_window";
      const step = limitField === "max_output" ? 256 : 1024;
      const minimum = limitField === "max_output" ? 256 : 1024;
      const maximum = limitField === "max_output" ? 200_000 : 2_000_000;
      if (key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -step : step;
        setCapDraft((previous) => {
          const current = Number.parseInt(previous[limitField], 10);
          const base = Number.isFinite(current) && current > 0 ? current : minimum;
          const next = String(Math.max(minimum, Math.min(maximum, base + delta)));
          return { ...previous, [limitField]: next };
        });
        return;
      }

      if (key.ctrl && input === "u") {
        setCapDraft((previous) => ({ ...previous, [limitField]: "" }));
        return;
      }

      if (isBackspaceKey(key, input) || isDeleteKey(key, input)) {
        setCapDraft((previous) => ({
          ...previous,
          [limitField]: previous[limitField].slice(0, -1),
        }));
        return;
      }

      if (/^[0-9]$/.test(input)) {
        setCapDraft((previous) => {
          const raw = `${previous[limitField]}${input}`.replace(/^0+(?=\d)/, "");
          return { ...previous, [limitField]: raw.slice(0, 8) };
        });
      }
      return;
    }

    if (key.escape) {
      setView(formReturnView);
      setError(undefined);
      setStatus(undefined);
      return;
    }

    if (key.return) {
      if (key.ctrl) void submitProvider(true);
      else void submitProvider(false);
      return;
    }

    if (key.tab) {
      moveFormField(key.shift ? -1 : 1);
      return;
    }

    if (key.downArrow) {
      moveFormField(1);
      return;
    }

    if (key.upArrow) {
      moveFormField(-1);
      return;
    }

    if (formMode === "edit" && activeFormField === "name") {
      setNameNotice("Provider slug is fixed while editing. Create a new provider to rename.");
      return;
    }

    if (key.ctrl && input === "u") {
      if (activeFormField === "kind") return;
      setForm((previous) => ({ ...previous, [activeFormField]: "" }));
      setFormCursor(0);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (activeFormField === "kind") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setForm((previous) => {
          const index = Math.max(0, kindChoices.indexOf(previous.kind));
          const delta = key.leftArrow ? -1 : 1;
          const next = kindChoices[(index + delta + kindChoices.length) % kindChoices.length];
          const previousDefault = DEFAULT_BASE_URLS[previous.kind];
          const baseUrl = customProvider
            ? previous.baseUrl
            : previous.baseUrl.trim().length === 0 || previous.baseUrl.trim() === previousDefault
              ? DEFAULT_BASE_URLS[next]
              : previous.baseUrl;
          return { ...previous, kind: next, baseUrl };
        });
        return;
      }
      return;
    }

    if (wordBackspace) {
      const next = deletePreviousWord(form[activeFormField], formCursor);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (wordDelete) {
      const next = deleteNextWord(form[activeFormField], formCursor);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (forwardDelete) {
      const next = deleteCharacterAfter(form[activeFormField], formCursor);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (isBackspaceKey(key, input)) {
      const next = deleteCharacterBefore(form[activeFormField], formCursor);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (isDeleteKey(key, input)) {
      const next = deleteCharacterAfter(form[activeFormField], formCursor);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
      if (activeFormField === "name") setNameNotice(undefined);
      return;
    }

    if (key.leftArrow) {
      setFormCursor((value) => Math.max(0, value - 1));
      return;
    }

    if (key.rightArrow) {
      setFormCursor((value) => Math.min(form[activeFormField].length, value + 1));
      return;
    }

    if (isPlainTextInput(input, key)) {
      if (activeFormField === "name") {
        const sanitized = input.replace(/[^A-Za-z0-9_-]/g, "");
        setNameNotice(
          sanitized === input
            ? undefined
            : "Spaces and special characters are blocked. Use letters, numbers, - and _.",
        );
        if (sanitized.length === 0) return;
        const next = insertTextAt(form.name, formCursor, sanitized);
        setForm((previous) => ({ ...previous, name: next.nextText }));
        setFormCursor(next.nextCursor);
        return;
      }
      const next = insertTextAt(form[activeFormField], formCursor, input);
      setForm((previous) => ({ ...previous, [activeFormField]: next.nextText }));
      setFormCursor(next.nextCursor);
    }
  });

  const renderTabs = (active: "models" | "providers") => (
    <Text>
      <Text
        bold={active === "models"}
        color={active === "models" ? theme.accent : theme.muted}
      >
        Models
      </Text>
      <Text color={theme.muted}>{"  ·  "}</Text>
      <Text
        bold={active === "providers"}
        color={active === "providers" ? theme.accent : theme.muted}
      >
        Providers
      </Text>
    </Text>
  );

  const renderEditableText = (
    value: string,
    cursor: number,
    masked = false,
  ): React.ReactNode => {
    const shown = masked
      ? `${"•".repeat(Math.min(value.length, 24))}${value.length > 24 ? "..." : ""}`
      : value;
    const point = Math.max(0, Math.min(shown.length, cursor));
    return (
      <>
        <Text>{shown.slice(0, point)}</Text>
        <Text inverse> </Text>
        <Text>{shown.slice(point)}</Text>
      </>
    );
  };

  if (confirmAction) {
    const title =
      confirmAction.kind === "delete-provider"
        ? `Delete provider "${confirmAction.provider}"?`
        : `Delete model "${confirmAction.model}" from ${confirmAction.provider}?`;
    const refs = [...confirmAction.refs.roles, ...confirmAction.refs.modes];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={theme.badge.error}>{title}</Text>
        {refs.length > 0 ? (
          <Text color={theme.muted}>
            Used by: {refs.join(", ")}. These references will be cleared.
          </Text>
        ) : (
          <Text color={theme.muted}>This item is not assigned to a role or mode.</Text>
        )}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
        <Text color={theme.muted}>Enter confirm · Esc cancel</Text>
      </Box>
    );
  }

  if (view === "models") {
    const activeModel = isModeTarget(targetRole)
      ? router.getModeModel(targetRole)
      : router.getRole(targetRole);
    const modeOverrides = router.modeModelOverrides();
    const activeMissing = activeModel
      ? (missingLocalModels.get(activeModel.provider)?.includes(activeModel.model) ?? false)
      : false;
    const selectedCaps = (() => {
      if (!selectedModel || selectedModel.source !== "config") return undefined;
      try {
        return router.capabilitiesFor(selectedModel.provider, selectedModel.model);
      } catch {
        return undefined;
      }
    })();
    const disabledCount = providers.filter((provider) => !provider.enabled).length;

    return (
      <Box flexDirection="column" paddingX={1}>
        {compact ? (
          <Text wrap="truncate">
            <Text bold color={theme.accent}>Models</Text>
            <Text color={theme.muted}> · Tab providers · Esc close</Text>
          </Text>
        ) : (
          <Box justifyContent="space-between">
            {renderTabs("models")}
            <Text color={theme.muted}>Esc close</Text>
          </Box>
        )}
        <Text wrap="truncate">
          <Text color={theme.muted}>Target </Text>
          <Text bold color={theme.text}>
            {targetRole === "main" ? "session" : targetRole}
          </Text>
          <Text color={theme.muted}>
            {" · "}
            {activeModel
              ? truncateText(
                  `${activeModel.provider} / ${activeModel.model}`,
                  Math.max(8, (process.stdout.columns ?? 80) - (compact ? 16 : 24)),
                )
              : "not configured"}
            {activeMissing ? " · not installed" : ""}
            {!compact ? "  (Ctrl+R cycle)" : ""}
          </Text>
        </Text>
        {!compact ? (
          <Text wrap="truncate" color={theme.muted}>
            {targetRole === "main"
              ? modeOverrides.length > 0
                ? `All modes use this model. Overrides: ${modeOverrides
                    .map((entry) => `${entry.mode} ${entry.model}`)
                    .join(", ")}`
                : "All modes use this model."
              : `Override for ${targetRole} only. Select session to change every mode.`}
          </Text>
        ) : null}

        {!compact ? (
          <Box justifyContent="space-between">
            <Text color={theme.muted}>Search</Text>
            <Text color={theme.muted}>
              {hasQuery ? `${filteredModels.length} match(es)` : "type to filter"}
            </Text>
          </Box>
        ) : null}
        {compact ? (
          <Text wrap="truncate">
            <Text color={theme.accent} bold>❯ </Text>
            {query.length > 0 ? (
              renderEditableText(query, queryCursor)
            ) : (
              <Text color={theme.muted}>Type model or provider</Text>
            )}
          </Text>
        ) : (
          <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
            <Text color={theme.accent} bold>❯ </Text>
            {query.length > 0 ? (
              renderEditableText(query, queryCursor)
            ) : (
              <>
                <Text inverse> </Text>
                <Text color={theme.muted}>Type model or provider</Text>
              </>
            )}
          </Box>
        )}

        {!compact && filteredModels.length > 0 && (filteredModels.length > MODEL_WINDOW || hasQuery) ? (
          <Text color={theme.muted}>
            Showing {windowStart + 1}-{windowEnd} of {filteredModels.length}
          </Text>
        ) : null}

        {discovering && modelGroups.length === 0 ? (
          <Text color={theme.muted}>Scanning local runtimes...</Text>
        ) : modelGroups.length === 0 ? (
          <Text color={theme.muted}>
            No enabled providers. Use /connect to add or enable one.
          </Text>
        ) : hasQuery && filteredModels.length === 0 ? (
          <Text color={theme.muted}>
            No models match "{query}". Clear the search to see all models.
          </Text>
        ) : filteredModels.length === 0 ? (
          <Text color={theme.muted}>
            No models yet. Use /connect to add models or enable a provider.
          </Text>
        ) : veryCompact ? (
          windowModels.map((entry) => {
            const index = filteredModels.indexOf(entry);
            const isSelected = index === clampedModelIndex;
            return (
              <Text key={`${entry.provider}-${entry.model}`} wrap="truncate">
                <Text color={isSelected ? theme.accent : theme.muted}>
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Text bold={isSelected} color={theme.text}>
                  {entry.displayName}
                </Text>
                {entry.displayName !== entry.model ? (
                  <Text color={theme.muted}> · {entry.model}</Text>
                ) : null}
              </Text>
            );
          })
        ) : (
          windowGroups.map((group) => (
            <Box key={group.key} flexDirection="column">
              <Text bold color={theme.modes.plan.primary}>{group.label}</Text>
              {group.models.map((entry) => {
                const index = filteredModels.indexOf(entry);
                const isSelected = index === clampedModelIndex;
                return (
                  <Text key={`${entry.provider}-${entry.model}`}>
                    <Text color={isSelected ? theme.accent : theme.muted}>
                      {isSelected ? "❯ " : "  "}
                    </Text>
                    <Text bold={isSelected} color={theme.text}>
                      {entry.displayName}
                    </Text>
                    {entry.displayName !== entry.model ? (
                      <Text color={theme.muted}> · {entry.model}</Text>
                    ) : null}
                    {group.profiles.length > 1 ? (
                      <Text color={theme.muted}> · {entry.provider}</Text>
                    ) : null}
                  </Text>
                );
              })}
            </Box>
          ))
        )}
        {!veryCompact && !hasQuery && filteredModels.length > 0 && emptyGroups.length > 0 ? (
          <Text color={theme.muted}>
            No models: {emptyGroups.map((group) => group.label).join(", ")} · manage in Providers
          </Text>
        ) : null}

        {!veryCompact && selectedCaps ? (
          <Text color={theme.muted}>
            {[
              selectedCaps.tool_calling ? "tools" : "no-tools",
              selectedCaps.reasoning ? "reasoning" : "no-reasoning",
              selectedCaps.vision ? "vision" : undefined,
              selectedCaps.context_window
                ? `${Math.round(selectedCaps.context_window / 1000)}k ctx`
                : undefined,
              selectedCaps.max_input
                ? `${Math.round(selectedCaps.max_input / 1000)}k in`
                : undefined,
              selectedCaps.max_output
                ? `${Math.round(selectedCaps.max_output / 1000)}k out`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}
        {!compact && hiddenNonChatCount > 0 ? (
          <Text color={theme.muted}>
            Hidden {hiddenNonChatCount} non-chat model(s) · Ctrl+A show all
          </Text>
        ) : null}
        {!compact && derivedNameCount > 0 ? (
          <Text color={theme.muted}>
            {derivedNameCount} name(s) generated from live model IDs
          </Text>
        ) : null}
        {!compact && disabledCount > 0 ? (
          <Text color={theme.muted}>
            {disabledCount} disabled provider(s) · manage in Providers
          </Text>
        ) : null}
        {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
        <Text color={theme.muted} wrap="truncate">
          {compact
            ? veryCompact
              ? "Enter assign · Esc close"
              : "Enter assign · Ctrl+E · Esc close"
            : "Type to search · Enter assign · Ctrl+E capabilities"}
        </Text>
        {!compact ? (
          <Text color={theme.muted}>Tab providers · Esc clear/close</Text>
        ) : null}
      </Box>
    );
  }

  if (view === "providers") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          {renderTabs("providers")}
          <Text color={theme.muted}>Esc close</Text>
        </Box>
        {!compact ? (
          <Text color={theme.muted}>Registered providers, including disabled ones.</Text>
        ) : null}
        {providers.length > 10 ? (
          <Text color={theme.muted}>
            Showing {providerStart + 1}-{providerEnd} of {providers.length}
          </Text>
        ) : null}
        {providers.length === 0 ? (
          <Text color={theme.muted}>No providers yet. Press a to add one.</Text>
        ) : (
          visibleProviders.map((provider, index) => {
            const actual = providerStart + index;
            const isSelected = actual === clampedProviderIndex;
            const runtime = runtimeForProvider(provider);
            const localMissing = missingLocalModels.get(provider.name) ?? [];
            const sync = remoteSync[provider.name];
            if (compact) {
              return (
                <Text key={provider.name} wrap="truncate">
                  <Text color={isSelected ? theme.accent : theme.muted}>
                    {isSelected ? "❯ " : "  "}
                  </Text>
                  <Text bold={isSelected} color={theme.text}>{provider.name}</Text>
                  <Text color={provider.enabled ? theme.modes.build.primary : theme.muted}>
                    {provider.enabled ? " · on" : " · off"}
                  </Text>
                  <Text color={theme.muted}>
                    {" · "}
                    {kindLabel(provider.kind)} · {provider.models.length} models
                  </Text>
                </Text>
              );
            }
            return (
              <Box key={provider.name} flexDirection="column">
                <Text>
                  <Text color={isSelected ? theme.accent : theme.muted}>
                    {isSelected ? "❯ " : "  "}
                  </Text>
                  <Text bold={isSelected} color={theme.text}>{provider.name.padEnd(20)}</Text>
                  <Text color={provider.enabled ? theme.modes.build.primary : theme.muted}>
                    {provider.enabled ? "enabled" : "disabled"}
                  </Text>
                  <Text color={theme.muted}>
                    {" · "}
                    {kindLabel(provider.kind)} · {provider.models.length} model(s)
                  </Text>
                  {runtime ? (
                    <Text color={localMissing.length > 0 ? theme.badge.error : theme.muted}>
                      {" · "}
                      {provider.models.length - localMissing.length} installed
                      {localMissing.length > 0 ? `, ${localMissing.length} not installed` : ""}
                    </Text>
                  ) : provider.kind === "ollama" ? (
                    <Text color={theme.muted}> · runtime offline</Text>
                  ) : sync ? (
                    <Text
                      color={
                        sync.state === "ok" && sync.missing.length > 0
                          ? theme.badge.error
                          : theme.muted
                      }
                    >
                      {" · "}
                      {sync.state === "checking"
                        ? "checking..."
                        : sync.state === "error"
                          ? "live check failed"
                          : sync.missing.length > 0
                            ? `${sync.missing.length} missing from live`
                            : `${sync.count} live`}
                    </Text>
                  ) : null}
                </Text>
                {isSelected ? <Text color={theme.muted}>    {provider.baseUrl}</Text> : null}
              </Box>
            );
          })
        )}
        {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
        {compact ? (
          <Text color={theme.muted} wrap="truncate">
            a add · Enter edit · Esc close
          </Text>
        ) : (
          <>
            <Text color={theme.muted}>a add · Enter/e edit · t enable/disable · d delete</Text>
            <Text color={theme.muted}>m manage models · Tab browse models · Esc close</Text>
          </>
        )}
      </Box>
    );
  }

  if (view === "providerAdd") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Add provider</Text>
          <Text color={theme.muted}>Esc back</Text>
        </Box>
        {PLATFORM_PRESETS.map((preset, index) => {
          const isSelected = index === clampedProviderAddIndex;
          return (
            <Text key={preset.id}>
              <Text color={isSelected ? theme.accent : theme.muted}>
                {isSelected ? "❯ " : "  "}
              </Text>
              <Text bold={isSelected} color={theme.text}>{preset.name}</Text>
              {preset.baseUrl ? (
                <Text color={theme.muted}> · {preset.baseUrl}</Text>
              ) : (
                <Text color={theme.muted}> · own URL and provider name</Text>
              )}
            </Text>
          );
        })}
        <Text color={theme.muted}>Up/Down move · Enter choose · Esc back</Text>
      </Box>
    );
  }

  if (view === "providerModels") {
    const manageSummary = providers.find((provider) => provider.name === manageProvider);
    const manageRuntime = manageSummary ? runtimeForProvider(manageSummary) : undefined;
    const managedMissing = manageProvider ? (missingLocalModels.get(manageProvider) ?? []) : [];
    const manageSync = manageProvider ? remoteSync[manageProvider] : undefined;
    const syncSummary = manageRuntime
      ? `${managedModels.length - managedMissing.length} installed${
          managedMissing.length > 0 ? `, ${managedMissing.length} not installed` : ""
        }`
      : manageSummary?.kind === "ollama"
        ? "runtime offline"
        : manageSync?.state === "checking"
          ? "checking..."
          : manageSync?.state === "error"
            ? "live check failed"
            : manageSync?.state === "ok"
              ? `${manageSync.count} live${
                  manageSync.missing.length > 0
                    ? `, ${manageSync.missing.length} missing`
                    : ""
                }`
              : `${managedModels.length} configured`;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Models for {manageProvider ?? "provider"}</Text>
          <Text color={theme.muted}>Esc back</Text>
        </Box>
        <Text color={theme.muted}>
          {managedModels.length} configured · {syncSummary} · r refresh from provider
        </Text>
        {managedModels.length > 12 ? (
          <Text color={theme.muted}>
            Showing {managedStart + 1}-{managedEnd} of {managedModels.length}
          </Text>
        ) : null}
        {managedModels.length === 0 ? (
          <Text color={theme.muted}>No models yet. Press a to add one.</Text>
        ) : (
          managedVisible.map((model, index) => {
            const actual = managedStart + index;
            const isSelected = actual === clampedManagedModelIndex;
            const missing = managedMissing.includes(model);
            const missingLive =
              manageSync?.state === "ok" && manageSync.missing.includes(model);
            return (
              <Text key={model}>
                <Text color={isSelected ? theme.accent : theme.muted}>
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Text bold={isSelected} color={theme.text}>{model}</Text>
                {missing ? <Text color={theme.badge.error}> · not installed</Text> : null}
                {missingLive ? <Text color={theme.badge.error}> · missing from live</Text> : null}
              </Text>
            );
          })
        )}
        {modelInputActive ? (
          <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
            <Text color={theme.accent} bold>New model: </Text>
            {modelInput.length > 0 ? (
              renderEditableText(modelInput, modelInputCursor)
            ) : (
              <>
                <Text inverse> </Text>
                <Text color={theme.muted}>Type model ID</Text>
              </>
            )}
          </Box>
        ) : null}
        {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
        {modelInputActive ? (
          <Text color={theme.muted}>
            Type model ID · Ctrl+Backspace/Delete word · Enter add · Esc cancel
          </Text>
        ) : (
          <>
            <Text color={theme.muted}>a add model · d delete · r refresh</Text>
            <Text color={theme.muted}>Enter/Ctrl+E capabilities · Esc back</Text>
          </>
        )}
      </Box>
    );
  }

  if (view === "reasoning") {
    const active = isModeTarget(targetRole) ? router.getModeModel(targetRole) : router.getRole(targetRole);
    const levels = levelOptions(targetRole);
    const currentLevel = isModeTarget(targetRole) ? router.getModeReasoning(targetRole) : reasoningEffort;
    const clamped = Math.max(0, Math.min(levels.length - 1, reasoningIndex));

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Thinking effort</Text>
          <Text color={theme.muted}>Esc back</Text>
        </Box>
        <Text color={theme.muted}>
          {active ? `${targetRole} now uses ${active.provider} / ${active.model}` : "Model assigned"}
        </Text>
        {levels.map((level, index) => {
          const isActive = index === clamped;
          const isCurrent = level.id === currentLevel;
          return (
            <Text key={level.id}>
              <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
              <Text bold={isActive} color={theme.text}>{level.label.padEnd(8)}</Text>
              <Text color={theme.muted}>
                {level.description}
                {isCurrent ? " · current" : ""}
              </Text>
            </Text>
          );
        })}
        <Text color={theme.muted}>Up/Down move · Enter select · Esc back</Text>
      </Box>
    );
  }

  if (view === "capabilities") {
    if (!capTarget) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color={theme.muted}>No model selected.</Text>
        </Box>
      );
    }
    const rows: Array<{ field: CapabilityField; label: string; value: string }> = [
      { field: "tool_calling", label: "Tool calling", value: capDraft.tool_calling ? "on" : "off" },
      { field: "reasoning", label: "Reasoning", value: capDraft.reasoning ? "on" : "off" },
      { field: "vision", label: "Vision", value: capDraft.vision ? "on" : "off" },
      { field: "structured_output", label: "Structured output", value: capDraft.structured_output ? "on" : "off" },
      { field: "temperature", label: "Temperature", value: capDraft.temperature ? "on" : "off" },
      { field: "pdf", label: "PDF input", value: capDraft.pdf ? "on" : "off" },
      { field: "parallel_tool_calls", label: "Parallel tools", value: capDraft.parallel_tool_calls ? "on" : "off" },
      { field: "context_window", label: "Context window", value: capDraft.context_window || "(auto)" },
      { field: "max_input", label: "Input limit", value: capDraft.max_input || "(follows context)" },
      { field: "max_output", label: "Max output", value: capDraft.max_output || "(auto)" },
    ];

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Model capabilities</Text>
          <Text color={theme.muted}>Esc back</Text>
        </Box>
        <Text color={theme.muted}>
          {capTarget.provider} / {capTarget.model}
        </Text>
        <Text color={capOverride ? theme.modes.build.primary : theme.muted}>
          {capOverride ? "override" : `auto (${capSource})`} · s save · r reset
        </Text>
        {rows.map((row, index) => {
          const isActive = index === capField;
          return (
            <Text key={row.field}>
              <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
              <Text bold={isActive} color={theme.text}>{row.label.padEnd(16)}</Text>
              <Text color={isActive ? theme.text : theme.muted}>{row.value}</Text>
            </Text>
          );
        })}
        <Text color={theme.muted}>
          Space/Enter toggle · Left/Right or type numbers · s save · r reset · Esc back
        </Text>
        {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.text}>
          {editingProvider
            ? `Edit ${editingProvider}`
            : customProvider
              ? "Custom provider"
              : "Add provider"}
        </Text>
        <Text color={theme.muted}>Esc back</Text>
      </Box>

      {visibleFormFields.map((name, index) => {
        const isActive = index === field;
        const label =
          name === "baseUrl"
            ? "Base URL"
            : name === "apiKey"
              ? "API key"
              : name === "models"
                ? "Models"
                : name === "name"
                  ? "Name"
                  : "API format";

        if (name === "kind" && customProvider) {
          return (
            <Text key={name}>
              <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
              <Text bold={isActive} color={theme.text}>{label.padEnd(12)}</Text>
              {kindChoices.map((choice, choiceIndex) => (
                <Text
                  key={choice}
                  color={form.kind === choice ? theme.accent : theme.muted}
                  bold={form.kind === choice}
                >
                  {choiceIndex > 0 ? "   " : ""}
                  {form.kind === choice ? "● " : "○ "}
                  {kindLabel(choice)}
                </Text>
              ))}
            </Text>
          );
        }

        const value = name === "kind" ? kindLabel(form.kind) : form[name];
        const displayValue =
          name === "apiKey" && value.length > 0
            ? `${"•".repeat(Math.min(value.length, 24))}${value.length > 24 ? "..." : ""}`
            : value;
        const placeholder =
          name === "name"
            ? "(required, slug)"
            : name === "baseUrl"
              ? "(required, full URL)"
              : name === "models"
                ? "(optional, comma separated)"
                : name === "apiKey"
                  ? "(stored in the active secrets file)"
                  : "";
        return (
          <Text key={name}>
            <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
            <Text bold={isActive} color={theme.text}>{label.padEnd(12)}</Text>
            {isActive && name !== "kind" ? (
              form[name].length > 0 ? (
                renderEditableText(form[name], formCursor, name === "apiKey")
              ) : (
                <>
                  <Text inverse> </Text>
                  <Text color={theme.muted}>{placeholder}</Text>
                </>
              )
            ) : (
              <Text color={isActive ? theme.text : theme.muted}>
                {displayValue.length > 0 ? displayValue : placeholder}
              </Text>
            )}
          </Text>
        );
      })}

      {activeFormField === "name" || liveNameError || nameNotice ? (
        <Text
          color={
            liveNameError || (nameNotice && formMode !== "edit")
              ? theme.badge.error
              : theme.muted
          }
        >
          {formMode === "edit"
            ? (nameNotice ?? "Provider slug is fixed while editing. Create a new provider to rename.")
            : liveNameError ??
              nameNotice ??
              "Use letters, numbers, - and _ (no spaces). Case is preserved."}
        </Text>
      ) : null}

      <Text color={theme.muted}>
        Tab next · Shift+Tab previous · Left/Right edit text or change format
      </Text>
      <Text color={theme.muted}>
        Ctrl+U clear field · Ctrl+Backspace/Delete word · Enter test and save
      </Text>
      <Text color={theme.muted}>Ctrl+Enter save without test</Text>
      <Text color={theme.muted}>
        {formMode === "edit"
          ? "Leave API key blank to keep the existing key. Use m in Providers to manage models."
          : customProvider
            ? "Custom providers use their own URL. Choose OpenAI-compatible or Anthropic-compatible."
            : "Preset values are editable. Keys are stored in the active secrets file."}
      </Text>
      {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
      {error ? <Text color={theme.badge.error}>{error}</Text> : null}
    </Box>
  );
}
