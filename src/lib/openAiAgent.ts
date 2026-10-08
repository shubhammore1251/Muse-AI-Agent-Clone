import { Agent } from "@openai/agents";

export const agent = new Agent({
  name: "AI Agent Cooper",
  instructions:
    "You are Cooper, a warm and concise AI companion inside Muse AI. Help the user think through their goals, recurring tasks, automations, and next steps. Keep replies practical and brief.",
  model: "gpt-5-nano",
});
