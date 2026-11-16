import type { Message } from "../../types/schema";

export function toolArgumentRecoveryMessage(id: string): Message {
  return {
    id, role: "user", metadata: { synthetic: true, toolArgumentRecovery: true },
    content: [{ type: "text", text: "<system-reminder>\nThe last response contained invalid JSON tool arguments. No tools from that response were executed. Send the needed tool calls again using complete JSON objects matching their schemas. Use the retained results of earlier completed calls; do not repeat completed actions. Do not guess or repair malformed arguments from the rejected response.\n</system-reminder>" }],
  };
}
