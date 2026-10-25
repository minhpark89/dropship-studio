function messageText(content) {
  if (Array.isArray(content)) return content.map(part => part?.text || "").join("");
  return content;
}

export async function readChatCompletion(response) {
  const raw = (await response.text()).trim();
  if (raw.length > 4 * 1024 * 1024) throw new Error("LLM response is too large");
  // Some compatible gateways send a complete JSON envelope followed directly
  // by an SSE DONE marker, even for a non-streaming request.
  const plain = raw.replace(/\s*data:\s*\[DONE\]\s*$/, "").trim();
  if (plain.startsWith("{")) {
    const body = JSON.parse(plain);
    if (body.choices?.[0]?.finish_reason === "length") throw new Error("LLM response was truncated");
    return messageText(body.choices?.[0]?.message?.content ?? body.output ?? body);
  }
  let content = "";
  let received = false;
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data.trim() === "[DONE]") continue;
    const body = JSON.parse(data);
    if (body.error) throw new Error("LLM stream failed");
    const choice = body.choices?.[0];
    if (choice?.finish_reason === "length") throw new Error("LLM response was truncated");
    if (choice?.message?.content !== undefined) { content = messageText(choice.message.content); received = true; }
    else if (choice?.delta?.content) { content += messageText(choice.delta.content); received = true; }
  }
  if (!received) throw new Error("LLM returned no content");
  return content;
}
