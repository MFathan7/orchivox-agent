import React from "react";
import { Box, Text, useInput } from "ink";

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
  saveModeReasoning,
  saveModeSelection,
  saveModelCapabilities,
  saveProviderProfile,
  saveRoleSelection,
  type ConfigMode,
  type ConfigRole,
} from "../config/writer";
import { discoverLocalProviders, type DiscoveredProvider } from "../provider/discover";
import { inspectOllamaModel } from "../provider/ollama-introspect";
import type { ProviderRouter } from "../provider/router";
import { filterFuzzy } from "./autocomplete";
import { REASONING_LEVELS, reasoningLevelsFor, type ReasoningEffortLevel } from "./command-palette";
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
  { id: "custom", name: "Custom base URL", kind: "openai", baseUrl: "" },
];

const CAPABILITY_FIELDS = [
  "tool_calling",
  "reasoning",
  "vision",
  "structured_output",
  "temperature",
  "pdf",
  "parallel_tool_calls",
  "context_window",
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
    max_output: capabilities.max_output !== undefined ? String(capabilities.max_output) : "",
  };
}

function isCapabilityBoolean(field: CapabilityField): field is Exclude<CapabilityField, "context_window" | "max_output"> {
  return field !== "context_window" && field !== "max_output";
}

type DiscoverEntry =
  | {
      type: "model";
      providerId: string;
      providerName: string;
      model: string;
      kind: ProviderKind;
      baseUrl: string;
    }
  | { type: "platform"; preset: PlatformPreset };

export interface ModelConfigModalProps {
  router: ProviderRouter;
  configPath: string;
  secretsPath: string;
  theme?: Theme;
  onClose: () => void;
  onSaved?: (message: string) => void;
  onRoleChange?: (role: ConfigRole, provider: string, model: string) => void;
  onModeModelChange?: (mode: ConfigMode, provider: string, model: string) => void;
  onModeReasoningChange?: (mode: ConfigMode, reasoning: string) => void;
  reasoningEffort?: ReasoningEffortLevel;
  onReasoningChange?: (effort: ReasoningEffortLevel) => void;
}

function kindIndex(kind: ProviderKind): number {
  return Math.max(0, PROVIDER_KINDS.indexOf(kind));
}

function profileFromForm(form: ProviderForm): ProviderProfile {
  return ProviderProfileSchema.parse({
    kind: form.kind,
    base_url: form.baseUrl.trim(),
    models: form.models
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
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
    onClose,
    onSaved,
    onRoleChange,
    onModeModelChange,
    onModeReasoningChange,
    reasoningEffort = "medium",
    onReasoningChange,
  } = props;

  const [view, setView] = React.useState<"discover" | "assign" | "connect" | "capabilities" | "reasoning">("discover");
  const [targetRole, setTargetRole] = React.useState<ModelTarget>("main");
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [discovered, setDiscovered] = React.useState<DiscoveredProvider[]>([]);
  const [discovering, setDiscovering] = React.useState(true);
  const [discoverIndex, setDiscoverIndex] = React.useState(0);
  const [reasoningIndex, setReasoningIndex] = React.useState(0);
  const [form, setForm] = React.useState<ProviderForm>(EMPTY_FORM);
  const [field, setField] = React.useState(0);
  const [status, setStatus] = React.useState<string | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  const [busy, setBusy] = React.useState(false);
  const [capTarget, setCapTarget] = React.useState<{ provider: string; model: string } | undefined>();
  const [capField, setCapField] = React.useState(0);
  const [capDraft, setCapDraft] = React.useState<CapabilitiesDraft>(EMPTY_CAPABILITIES_DRAFT);
  const [capOverride, setCapOverride] = React.useState(false);
  const [capSource, setCapSource] = React.useState<string>("inferred");
  const [, forceRender] = React.useReducer((value: number) => value + 1, 0);

  const providers = router.listProviders();
  const configuredModels = router.listAllConfiguredModels();
  const activeFormField: FormField = FORM_FIELDS[field] ?? "name";

  const allModels = React.useMemo(() => {
    const seen = new Set(configuredModels.map((entry) => `${entry.provider}\u0000${entry.model}`));
    const list: Array<{
      provider: string;
      model: string;
      kind: string;
      source: "config" | "catalog";
    }> = configuredModels.map((entry) => ({ ...entry, source: "config" as const }));

    for (const provider of providers) {
      if (!provider.enabled) continue;
      for (const model of router.listCatalogModels(provider.name)) {
        const key = `${provider.name}\u0000${model.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ provider: provider.name, model: model.id, kind: provider.kind, source: "catalog" });
      }
    }

    return list;
  }, [configuredModels, providers, router]);

  const levelOptions = (target: ModelTarget) => {
    if (isModeTarget(target)) return reasoningLevelsFor(router.reasoningOptionsForMode(target));
    if (target === "main") return reasoningLevelsFor(router.reasoningOptionsForRole("main"));
    return REASONING_LEVELS;
  };

  const filteredModels = React.useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return allModels;
    return filterFuzzy(trimmed, allModels, (entry) => `${entry.provider} ${entry.model}`, 30).map(
      (entry) => entry.item,
    );
  }, [allModels, query]);

  const discoverEntries = React.useMemo<DiscoverEntry[]>(() => {
    const entries: DiscoverEntry[] = [];
    for (const provider of discovered) {
      for (const model of provider.models.slice(0, 10)) {
        entries.push({
          type: "model",
          providerId: provider.id,
          providerName: provider.name,
          model,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
        });
      }
    }
    for (const preset of PLATFORM_PRESETS) {
      entries.push({ type: "platform", preset });
    }
    return entries;
  }, [discovered]);

  const clampedDiscoverIndex = Math.max(0, Math.min(discoverEntries.length - 1, discoverIndex));

  React.useEffect(() => {
    let cancelled = false;
    setDiscovering(true);
    discoverLocalProviders()
      .then((providers) => {
        if (cancelled) return;
        setDiscovered(providers);
        setDiscovering(false);
        setDiscoverIndex(0);
      })
      .catch(() => {
        if (cancelled) return;
        setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openConnect = (preset?: PlatformPreset): void => {
    const nameTaken = preset ? router.listProviders().some((provider) => provider.name === preset.id) : false;
    setForm({
      ...EMPTY_FORM,
      name: preset && preset.id !== "custom" && !nameTaken ? preset.id : "",
      kind: preset?.kind ?? "openai",
      baseUrl: preset?.baseUrl ?? "",
    });
    setField(0);
    setError(undefined);
    setStatus(undefined);
    setView("connect");
  };

  const registerDiscovered = async (entry: Extract<DiscoverEntry, { type: "model" }>): Promise<void> => {
    try {
      const existing = router.listProviders().find((provider) => provider.name === entry.providerId);
      if (!existing) {
        const found = discovered.find((provider) => provider.id === entry.providerId);
        const profile = ProviderProfileSchema.parse({
          kind: entry.kind,
          base_url: entry.baseUrl,
          models: found?.models ?? [entry.model],
          enabled: true,
        });
        await saveProviderProfile({
          configPath,
          secretsPath,
          name: entry.providerId,
          profile,
        });
        router.addProvider(entry.providerId, profile);
      }
      await assignModel(entry.providerId, entry.model);
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
      }

      setStatus(`${targetRole} now uses ${provider} / ${model}`);
      setError(undefined);
      setQuery("");
      setSelectedIndex(0);
      forceRender();

      if (targetRole === "main" || isModeTarget(targetRole)) {
        const levels = levelOptions(targetRole);
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

  const openCapabilities = (provider: string, model: string): void => {
    try {
      const capabilities = router.capabilitiesFor(provider, model);
      setCapTarget({ provider, model });
      setCapDraft(draftFromCapabilities(capabilities));
      setCapSource(capabilities.source ?? "inferred");
      setCapOverride(Boolean(router.capabilitiesOverrideFor(provider, model)));
      setCapField(0);
      setStatus(undefined);
      setError(undefined);
      setView("capabilities");

      const summary = router.listProviders().find((entry) => entry.name === provider);
      if (summary?.kind === "ollama") {
        void inspectOllamaModel(summary.baseUrl, model)
          .then((live) => {
            if (!live) return;
            const refreshed = router.capabilitiesFor(provider, model);
            setCapDraft(draftFromCapabilities(refreshed));
            setCapSource(refreshed.source ?? "inferred");
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
      setCapSource(capabilities.source ?? "inferred");
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
    const name = form.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      setError("Provider name must start with a letter or digit and contain only letters, digits, dashes, or underscores.");
      return;
    }
    if (router.listProviders().some((entry) => entry.name === name)) {
      setError(`Provider "${name}" already exists. Choose another name.`);
      return;
    }

    let profile: ProviderProfile;
    try {
      profile = profileFromForm(form);
    } catch (cause) {
      setError(describeError(cause));
      return;
    }

    const apiKey = form.apiKey.trim();
    const candidate: ProviderProfile = {
      ...profile,
      api_key: apiKey.length > 0 ? apiKey : undefined,
    };

    setBusy(true);
    setError(undefined);
    setStatus(skipTest ? "Saving provider..." : "Testing provider...");

    try {
      let remoteModels: string[] = [];
      if (!skipTest) {
        remoteModels = await router.testProvider(candidate);
      }
      const models = profile.models.length > 0 ? profile.models : remoteModels.slice(0, 40);
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

      if (!router.getRole("main") && models.length > 0) {
        router.setRole("main", name, models[0]);
        await saveRoleSelection(configPath, "main", name, models[0]);
        onRoleChange?.("main", name, models[0]);
      }

      setStatus(
        models.length > 0
          ? `Connected ${name} with ${models.length} model(s).`
          : `Saved ${name}. Add models later if the provider lists none.`,
      );
      setForm(EMPTY_FORM);
      setField(0);
      setView("discover");
      forceRender();
      onSaved?.(`connected ${name}`);
    } catch (cause) {
      setError(describeError(cause));
      setStatus(undefined);
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) {
      if (key.escape) onClose();
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

    if (view === "discover") {
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "r") {
        const index = TARGET_ORDER.indexOf(targetRole);
        setTargetRole(TARGET_ORDER[(index + 1) % TARGET_ORDER.length]);
        return;
      }
      if (input === "a") {
        setView("assign");
        setQuery("");
        setSelectedIndex(0);
        setError(undefined);
        return;
      }
      if (input === "c") {
        openConnect();
        return;
      }
      if (key.upArrow) {
        setDiscoverIndex((value) => (value > 0 ? value - 1 : Math.max(0, discoverEntries.length - 1)));
        return;
      }
      if (key.downArrow) {
        setDiscoverIndex((value) => (value < discoverEntries.length - 1 ? value + 1 : 0));
        return;
      }
      if (key.return) {
        const entry = discoverEntries[clampedDiscoverIndex];
        if (!entry) return;
        if (entry.type === "model") void registerDiscovered(entry);
        else openConnect(entry.preset);
        return;
      }
      return;
    }

    if (view === "assign") {
      if (key.escape) {
        setView("discover");
        setQuery("");
        setError(undefined);
        return;
      }
      if (key.ctrl && input === "e") {
        const entry = filteredModels[selectedIndex];
        if (entry) openCapabilities(entry.provider, entry.model);
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((value) => (value > 0 ? value - 1 : Math.max(0, filteredModels.length - 1)));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((value) => (value < filteredModels.length - 1 ? value + 1 : 0));
        return;
      }
      if (key.return) {
        const entry = filteredModels[selectedIndex];
        if (entry) void assignModel(entry.provider, entry.model);
        return;
      }
      const isBackspace = Boolean(key.backspace || input === "\x7f" || input === "\b");
      if (isBackspace) {
        setQuery((value) => value.slice(0, -1));
        setSelectedIndex(0);
        return;
      }
      if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && !input.startsWith("\x1b")) {
        setQuery((value) => value + input);
        setSelectedIndex(0);
      }
      return;
    }

    if (view === "capabilities") {
      if (key.escape) {
        setView("assign");
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

      const step = fieldName === "context_window" ? 1024 : 256;
      const minimum = fieldName === "context_window" ? 1024 : 256;
      const maximum = fieldName === "context_window" ? 2_000_000 : 200_000;
      if (key.leftArrow || key.rightArrow) {
        const delta = key.leftArrow ? -step : step;
        setCapDraft((previous) => {
          const current = Number.parseInt(previous[fieldName], 10);
          const base = Number.isFinite(current) && current > 0 ? current : minimum;
          const next = String(Math.max(minimum, Math.min(maximum, base + delta)));
          return fieldName === "context_window"
            ? { ...previous, context_window: next }
            : { ...previous, max_output: next };
        });
        return;
      }

      const isBackspace = Boolean(key.backspace || input === "\x7f" || input === "\b");
      if (isBackspace) {
        setCapDraft((previous) =>
          fieldName === "context_window"
            ? { ...previous, context_window: previous.context_window.slice(0, -1) }
            : { ...previous, max_output: previous.max_output.slice(0, -1) },
        );
        return;
      }

      if (/^[0-9]$/.test(input)) {
        setCapDraft((previous) => {
          const raw = `${previous[fieldName]}${input}`.replace(/^0+(?=\d)/, "");
          const next = raw.slice(0, 8);
          return fieldName === "context_window"
            ? { ...previous, context_window: next }
            : { ...previous, max_output: next };
        });
      }
      return;
    }

    if (key.escape) {
      setView("discover");
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
      setField((value) => (value + (key.shift ? -1 : 1) + FORM_FIELDS.length) % FORM_FIELDS.length);
      return;
    }

    if (key.downArrow) {
      setField((value) => (value + 1) % FORM_FIELDS.length);
      return;
    }

    if (key.upArrow) {
      setField((value) => (value - 1 + FORM_FIELDS.length) % FORM_FIELDS.length);
      return;
    }

    if (activeFormField === "kind") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setForm((previous) => {
          const index = kindIndex(previous.kind);
          const delta = key.leftArrow ? -1 : 1;
          const next = PROVIDER_KINDS[(index + delta + PROVIDER_KINDS.length) % PROVIDER_KINDS.length];
          const previousDefault = DEFAULT_BASE_URLS[previous.kind];
          const baseUrl =
            previous.baseUrl.trim().length === 0 || previous.baseUrl.trim() === previousDefault
              ? DEFAULT_BASE_URLS[next]
              : previous.baseUrl;
          return { ...previous, kind: next, baseUrl };
        });
        return;
      }
    }

    const isBackspace = Boolean(key.backspace || input === "\x7f" || input === "\b");
    if (isBackspace) {
      setForm((previous) => {
        if (activeFormField === "kind") return previous;
        const current = previous[activeFormField];
        return { ...previous, [activeFormField]: current.slice(0, -1) };
      });
      return;
    }

    if (!key.ctrl && !key.meta && input.length > 0 && input >= " " && !input.startsWith("\x1b")) {
      setForm((previous) => {
        if (activeFormField === "kind") return previous;
        const current = previous[activeFormField];
        return { ...previous, [activeFormField]: `${current}${input}` };
      });
    }
  });

  if (view === "discover") {
    const activeModel = isModeTarget(targetRole) ? router.getModeModel(targetRole) : router.getRole(targetRole);
    const configuredNames = new Set(providers.map((provider) => provider.name));
    const localModelCount = discovered.reduce((total, provider) => total + Math.min(provider.models.length, 10), 0);

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Models</Text>
          <Text color={theme.muted}>Esc close</Text>
        </Box>

        <Text>
          <Text color={theme.muted}>Target </Text>
          <Text bold color={theme.text}>{targetRole}</Text>
          <Text color={theme.muted}>
            {" · "}
            {activeModel ? `${activeModel.provider} / ${activeModel.model}` : "not configured"}
            {"  (r cycle)"}
          </Text>
        </Text>

        <Text bold color={theme.modes.plan.primary}>Local models</Text>
        {discovering ? (
          <Text color={theme.muted}>Scanning local runtimes...</Text>
        ) : localModelCount === 0 ? (
          <Text color={theme.muted}>No local models found. Start Ollama or connect a platform below.</Text>
        ) : (
          discovered.map((provider) => {
            const connected = configuredNames.has(provider.id);
            return (
              <Box key={provider.id} flexDirection="column">
                <Text color={theme.muted}>
                  {provider.name}
                  {connected ? " · connected" : ""}
                </Text>
                {provider.models.slice(0, 10).map((model) => {
                  const index = discoverEntries.findIndex(
                    (entry) => entry.type === "model" && entry.providerId === provider.id && entry.model === model,
                  );
                  const isSelected = index === clampedDiscoverIndex;
                  return (
                    <Text key={model}>
                      <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                      <Text bold={isSelected} color={theme.text}>{model}</Text>
                    </Text>
                  );
                })}
              </Box>
            );
          })
        )}

        <Text bold color={theme.modes.plan.primary}>Another platforms</Text>
        {PLATFORM_PRESETS.map((preset) => {
          const index = discoverEntries.findIndex(
            (entry) => entry.type === "platform" && entry.preset.id === preset.id,
          );
          const isSelected = index === clampedDiscoverIndex;
          return (
            <Text key={preset.id}>
              <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
              <Text bold={isSelected} color={theme.text}>{preset.name}</Text>
              {preset.baseUrl ? <Text color={theme.muted}> · {preset.baseUrl}</Text> : null}
            </Text>
          );
        })}

        {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}

        <Text color={theme.muted}>
          Enter assign/connect · r target · a assign all · c connect · Esc close
        </Text>
      </Box>
    );
  }

  if (view === "assign") {
    const maxVisible = 10;
    const clamped = Math.max(0, Math.min(filteredModels.length - 1, selectedIndex));
    let start = Math.max(0, clamped - Math.floor(maxVisible / 2));
    if (start + maxVisible > filteredModels.length) start = Math.max(0, filteredModels.length - maxVisible);
    const visible = filteredModels.slice(start, start + maxVisible);
    const selectedEntry = filteredModels[clamped];
    const selectedCaps = selectedEntry
      ? router.capabilitiesFor(selectedEntry.provider, selectedEntry.model)
      : undefined;

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color={theme.text}>Assign model to {targetRole}</Text>
          <Text color={theme.muted}>Esc back</Text>
        </Box>
        <Box borderStyle="single" borderColor={theme.border.passive} paddingX={1}>
          <Text color={theme.accent} bold>❯ </Text>
          <Text color={theme.text}>{query}</Text>
          <Text inverse color={theme.accent}> </Text>
        </Box>
        {filteredModels.length === 0 ? (
          <Box flexDirection="column">
            <Text color={theme.muted}>No models match. Connect a provider with c first.</Text>
          </Box>
        ) : (
          visible.map((entry, index) => {
            const actual = start + index;
            const isSelected = actual === clamped;
            return (
              <Text key={`${entry.provider}-${entry.model}`}>
                <Text color={isSelected ? theme.accent : theme.muted}>{isSelected ? "❯ " : "  "}</Text>
                <Text bold={isSelected} color={theme.text}>{entry.model}</Text>
                <Text color={theme.muted}>
                  {" · "}
                  {entry.provider} ({entry.kind})
                  {entry.source === "catalog" ? " · catalog" : ""}
                </Text>
              </Text>
            );
          })
        )}
        {error ? <Text color={theme.badge.error}>{error}</Text> : null}
        {selectedCaps ? (
          <Text color={theme.muted}>
            {[
              selectedCaps.tool_calling ? "tools" : "no-tools",
              selectedCaps.reasoning ? "reasoning" : "no-reasoning",
              selectedCaps.vision ? "vision" : undefined,
              selectedCaps.context_window ? `${Math.round(selectedCaps.context_window / 1000)}k ctx` : undefined,
              selectedCaps.max_output ? `${Math.round(selectedCaps.max_output / 1000)}k out` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : null}
        <Text color={theme.muted}>Enter assign · Ctrl+E capabilities · Up/Down move · Esc back</Text>
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
          <Text color={theme.muted}>Esc skip</Text>
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
        <Text color={theme.muted}>Up/Down move · Enter select · Esc skip</Text>
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
        <Text bold color={theme.text}>Connect provider</Text>
        <Text color={theme.muted}>Esc back</Text>
      </Box>

      {(["name", "kind", "baseUrl", "apiKey", "models"] as FormField[]).map((name, index) => {
        const isActive = index === field;
        const label = name === "baseUrl" ? "Base URL" : name === "apiKey" ? "API key" : name === "models" ? "Models" : name === "name" ? "Name" : "Kind";
        const value =
          name === "kind"
            ? form.kind
            : form[name];
        const displayValue =
          name === "apiKey" && value.length > 0
            ? `${"•".repeat(Math.min(value.length, 24))}${value.length > 24 ? "..." : ""}`
            : value;
        return (
          <Text key={name}>
            <Text color={isActive ? theme.accent : theme.muted}>{isActive ? "❯ " : "  "}</Text>
            <Text bold={isActive} color={theme.text}>{label.padEnd(10)}</Text>
            <Text color={isActive ? theme.text : theme.muted}>
              {displayValue.length > 0 ? displayValue : name === "models" ? "(optional, comma separated)" : name === "apiKey" ? "(stored in .agent/secrets.yaml)" : ""}
            </Text>
          </Text>
        );
      })}

      <Text color={theme.muted}>
        Tab next · Shift+Tab previous · Left/Right change kind · Enter test and save · Ctrl+Enter save without test
      </Text>
      <Text color={theme.muted}>
        Use kind openai for any OpenAI-compatible platform. Keys are stored in .agent/secrets.yaml.
      </Text>
      {status ? <Text color={theme.modes.build.primary}>{status}</Text> : null}
      {error ? <Text color={theme.badge.error}>{error}</Text> : null}
    </Box>
  );
}
