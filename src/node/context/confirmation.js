function containsSessionId(record, sessionIds) {
  if (!sessionIds?.size) return false;
  let serialized;
  try { serialized = JSON.stringify(record); } catch { return false; }
  for (const id of sessionIds) if (serialized.includes(id)) return true;
  return false;
}

export function recordConfirmsRabbitholeSession(agent, record, sessionIds) {
  if (!containsSessionId(record, sessionIds)) return false;
  if (agent === "claude") {
    const blocks = Array.isArray(record?.message?.content) ? record.message.content : [];
    return blocks.some((block) =>
      block?.type === "tool_result" ||
      (block?.type === "tool_use" && /^mcp__rabb?it-?hole__?(?:open_rabbithole|answer_branch)$/i.test(String(block.name || "")))
    );
  }
  if (agent === "codex") {
    const payload = record?.payload;
    return payload?.type === "function_call_output" ||
      (payload?.type === "function_call" && payload?.namespace === "mcp__rabbithole" &&
        (payload?.name === "open_rabbithole" || payload?.name === "answer_branch"));
  }
  return false;
}

export function textConfirmsRabbitholeSession(agent, text, sessionIds) {
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      if (recordConfirmsRabbitholeSession(agent, JSON.parse(line), sessionIds)) return true;
    } catch {}
  }
  return false;
}
