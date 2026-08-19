const IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;
const IMAGE_DETAILS = new Set(["auto", "low", "high"]);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function joinSystemMessages(messages = []) {
  return messages
    .filter((message) => message?.role === "system")
    .map((message) => textFromContent(message.content))
    .filter(Boolean)
    .join("\n\n");
}

export function serializeTranscript(messages = []) {
  const turns = messages
    .filter((message) => message && message.role !== "system")
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `<${role}>${textFromContent(message.content)}</${role}>`;
    });
  return `Conversation transcript:\n${turns.join("\n")}`;
}

function dataUrlImageBlock(part) {
  if (part?.type !== "image_url") return null;
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (typeof url !== "string") return null;
  const match = IMAGE_DATA_URL.exec(url);
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  const data = match[2].replace(/\s/g, "");
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data,
    },
  };
}

function codexImageBlock(part) {
  const image = dataUrlImageBlock(part);
  if (!image) return null;
  const requestedDetail = typeof part.image_url === "object" ? part.image_url?.detail : "";
  return {
    type: "image",
    url: `data:${image.source.media_type};base64,${image.source.data}`,
    detail: IMAGE_DETAILS.has(requestedDetail) ? requestedDetail : "auto",
  };
}

export function buildClaudeInput(messages = []) {
  const content = [{ type: "text", text: serializeTranscript(messages) }];
  let imagePartCount = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url") imagePartCount += 1;
      const image = dataUrlImageBlock(part);
      if (image) content.push(image);
    }
  }
  return {
    systemPrompt: joinSystemMessages(messages),
    input: {
      type: "user",
      message: {
        role: "user",
        content,
      },
    },
    imageCount: content.length - 1,
    imagePartCount,
  };
}

export function countImageParts(messages = []) {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url") count += 1;
    }
  }
  return count;
}

export function buildCodexInput(messages = []) {
  const transcript = serializeTranscript(messages);
  const input = [{ type: "text", text: transcript }];
  let imagePartCount = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "image_url") continue;
      imagePartCount += 1;
      const image = codexImageBlock(part);
      if (image) input.push(image);
    }
  }
  return {
    systemPrompt: joinSystemMessages(messages),
    input,
    imageCount: input.length - 1,
    imagePartCount,
  };
}
