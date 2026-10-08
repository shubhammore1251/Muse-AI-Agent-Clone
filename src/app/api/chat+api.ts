import { agent } from "@/lib/openAiAgent";
import { ChatMessage } from "@/types";
import { AgentInputItem, run } from "@openai/agents";

type ChatRequestBody = {
  messages: ChatMessage[];
};

console.log("OPENAI KEY AVAILABLE:", !!process.env.OPENAI_API_KEY);

export async function POST(req: Request) {
  const body = (await req.json()) as ChatRequestBody;

  const messages = body.messages;

  const mappedMessages = MapAgentInput(messages);

  const result = await run(agent, mappedMessages);

  return Response.json({
    output: result.finalOutput ?? "",
  });
}

const MapAgentInput = (messages: ChatMessage[]): AgentInputItem[] => {
  return messages.map((message: ChatMessage) => {
    if (message.sender === "agent") {
      return {
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: message.text,
          },
        ],
      };
    }
    return {
      role: "user",
      content: message.text,
    };
  });
};
