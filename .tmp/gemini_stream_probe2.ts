import { GoogleGenAI } from "@google/genai";
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const stream = await (client as any).interactions.create({
  model: "gemini-3.1-pro-preview",
  input: [{ role: "user", content: "Say hi" }],
  generation_config: { max_output_tokens: 256, temperature: 0, thinking_level: "minimal", thinking_summaries: "auto" },
  store: false,
  stream: true,
});
let i=0;
for await (const ev of stream) {
  i++;
  if (ev?.event_type === "content.delta") {
    console.log("delta", JSON.stringify(ev.delta));
  } else {
    console.log("event", ev?.event_type);
  }
}
console.log("events", i);
