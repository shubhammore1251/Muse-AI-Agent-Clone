import { chatTitleAgent } from "@/lib/openAiAgent";
import { run } from "@openai/agents";

export async function POST(req: Request) {
  try {
    const { assistantResponse } = await req.json();

    if (typeof assistantResponse !== "string" || !assistantResponse.trim()) {
      return Response.json(
        { error: "Assistant response is required" },
        { status: 400 },
      );
    }

    const result = await run(
      chatTitleAgent,
      `Assistant's first response:\n${assistantResponse}`,
    );

    return Response.json({
      title: result.finalOutput?.trim() || "SKIP_TITLE",
    });
  } catch (error) {
    console.error("TITLE API ERROR:", error);

    return Response.json(
      { error: "Failed to generate chat title" },
      { status: 500 },
    );
  }
}
