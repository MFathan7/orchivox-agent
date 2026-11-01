import { createHash } from "node:crypto";

import type { Message } from "../../types/schema";
import type { InstructionBlock } from "./instructions";

export interface InstructionState {
  version: 1;
  /** Hash of the last active text sent for each instruction source. */
  active: Record<string, string>;
  /** Sources that were removed after being active. */
  removed: string[];
}

export type InstructionUpdateKind = "initial" | "changed" | "removed";

export interface InstructionUpdate {
  kind: InstructionUpdateKind;
  key: string;
  hash?: string;
  text?: string;
}

export interface InstructionPlan {
  updates: InstructionUpdate[];
  nextState: InstructionState;
}

interface InstructionMarker {
  key: string;
  hash: string | null;
  removed: boolean;
}

export function isInstructionState(value: unknown): value is InstructionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return false;
  const active = record.active;
  if (!active || typeof active !== "object" || Array.isArray(active)) return false;
  for (const hash of Object.values(active)) {
    if (typeof hash !== "string") return false;
  }
  const removed = record.removed;
  return Array.isArray(removed) && removed.every((item) => typeof item === "string");
}

export function instructionHash(key: string, text: string): string {
  const normalized =
    key === "environment"
      ? text.replace(/^- Local time: .*$/m, "- Local time: <session>")
      : text;
  return createHash("sha256").update(`${key}\n${normalized}`).digest("hex");
}

export function isInstructionMessage(message: Message): boolean {
  return message.metadata?.instruction !== undefined;
}

export function mergeInstructionMessages(
  messages: Message[],
  instructionMessages: Message[],
): Message[] {
  const known = new Set(messages.map((message) => message.id));
  const missing = instructionMessages.filter((message) => !known.has(message.id));
  if (missing.length === 0) return messages;
  const index = lastRealUserIndex(messages);
  return [...messages.slice(0, index), ...missing, ...messages.slice(index)];
}

export function planInstructionUpdates(input: {
  blocks: InstructionBlock[];
  messages: Message[];
  state?: InstructionState;
}): InstructionPlan {
  const markers = instructionMarkers(input.messages);
  const current = new Map<string, { text: string; hash: string }>();
  for (const block of input.blocks) {
    const text = block.text.trim();
    if (text.length === 0) continue;
    current.set(block.key, { text, hash: instructionHash(block.key, text) });
  }

  const updates: InstructionUpdate[] = [];
  for (const [key, block] of current) {
    const marker = markers.get(key);
    const visibleHash = marker && !marker.removed ? marker.hash : undefined;
    const stateHash = input.state?.active[key];
    if (visibleHash === block.hash) continue;

    const previousHash = visibleHash ?? stateHash;
    if (previousHash !== undefined && previousHash !== block.hash) {
      updates.push({ kind: "changed", key, hash: block.hash, text: block.text });
    } else {
      updates.push({ kind: "initial", key, hash: block.hash, text: block.text });
    }
  }

  const removed = new Set(input.state?.removed ?? []);
  const knownKeys = new Set([
    ...Object.keys(input.state?.active ?? {}),
    ...markers.keys(),
  ]);
  for (const key of knownKeys) {
    if (current.has(key) || removed.has(key)) continue;
    const marker = markers.get(key);
    if (marker?.removed) {
      removed.add(key);
      continue;
    }
    updates.push({ kind: "removed", key });
    removed.add(key);
  }

  return {
    updates,
    nextState: {
      version: 1,
      active: Object.fromEntries([...current].map(([key, block]) => [key, block.hash])),
      removed: [...removed].filter((key) => !current.has(key)).sort(),
    },
  };
}

export function renderInstructionUpdate(update: InstructionUpdate): string {
  if (update.kind === "removed") {
    return [
      "# Instructions removed",
      `The previous ${update.key} instructions no longer apply.`,
    ].join("\n\n");
  }
  if (update.kind === "changed") {
    return [
      `# Instructions updated: ${update.key}`,
      `This replaces the earlier ${update.key} block.`,
      update.text ?? "",
    ].join("\n\n");
  }
  return [`# Instructions`, update.text ?? ""].join("\n\n");
}

export function instructionMessage(id: string, update: InstructionUpdate): Message {
  return {
    id,
    role: "user",
    content: [{ type: "text", text: renderInstructionUpdate(update) }],
    metadata: {
      synthetic: true,
      instruction: {
        key: update.key,
        hash: update.hash ?? null,
        removed: update.kind === "removed",
      },
    },
  };
}

function instructionMarkers(messages: Message[]): Map<string, InstructionMarker> {
  const markers = new Map<string, InstructionMarker>();
  for (const message of messages) {
    const marker = parseMarker(message.metadata?.instruction);
    if (marker) markers.set(marker.key, marker);
  }
  return markers;
}

function parseMarker(value: unknown): InstructionMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string") return undefined;
  return {
    key: record.key,
    hash: typeof record.hash === "string" ? record.hash : null,
    removed: record.removed === true,
  };
}

function lastRealUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.metadata?.synthetic !== true) return index;
  }
  return messages.length;
}
