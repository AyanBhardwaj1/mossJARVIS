import { NextResponse } from "next/server";
import {
  addWorkingTurn,
  createJarvisSession,
  openTasks,
  persistTurn,
  queryBoth,
  type JarvisTask,
  type RetrievedMemory,
} from "@/lib/jarvis-store";
import { configStatus, configValue, setRuntimeConfig, type RuntimeConfig } from "@/lib/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LlmTurn = {
  response: string;
  facts: string[];
  tasks: JarvisTask[];
};

function cleanJson(text: string) {
  return text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

async function callOpenRouter(messages: Array<{ role: "system" | "user"; content: string }>) {
  const apiKey = configValue("openRouterApiKey", "OPENROUTER_API_KEY");
  const model = configValue("openRouterModel", "OPENROUTER_MODEL", "openai/gpt-4.1-mini");
  if (!apiKey) throw new Error("OpenRouter is offline. Add OPENROUTER_API_KEY to .env.local.");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": configValue("appUrl", "APP_URL", "http://localhost:3000"),
      "X-Title": "Jarvis Second Brain",
    },
    body: JSON.stringify({
      model,
      temperature: 0.35,
      max_tokens: 650,
      response_format: { type: "json_object" },
      messages,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("OpenRouter request failed", response.status, detail);
    throw new Error(`OpenRouter returned ${response.status}.`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenRouter returned an invalid response.");
  return content;
}

function memoryText(memories: RetrievedMemory[]) {
  return memories.map((item) => `[${item.source}:${item.id}] ${item.text}`).join("\n") || "None";
}

async function answerTurn(
  text: string,
  working: RetrievedMemory[],
  longTerm: RetrievedMemory[],
): Promise<LlmTurn> {
  const today = new Date().toISOString();
  const raw = await callOpenRouter([
    {
      role: "system",
      content: `You are Jarvis, a precise, calm personal AI assistant with a subtle British manner. Be useful and concise when spoken aloud. Never mention retrieval internals unless asked.

Today is ${today}. Extract durable user facts and requested reminders/tasks. Resolve relative due dates to an ISO date/time when reasonably possible. Return JSON only:
{"response":"spoken answer","facts":["durable fact"],"tasks":[{"title":"task","due":"ISO date or empty","recurrence":"none or rule","priority":"low|normal|high"}]}
Do not create tasks unless the user actually requests one. Do not store transient questions as facts.`,
    },
    {
      role: "user",
      content: `Current request:\n${text}\n\nWorking memory:\n${memoryText(working)}\n\nLong-term second brain:\n${memoryText(longTerm)}`,
    },
  ]);

  const parsed = JSON.parse(cleanJson(raw)) as Partial<LlmTurn>;
  if (!parsed.response || typeof parsed.response !== "string") {
    throw new Error("Jarvis could not parse the model response.");
  }
  return {
    response: parsed.response,
    facts: Array.isArray(parsed.facts) ? parsed.facts.filter((item): item is string => typeof item === "string") : [],
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks.filter((item): item is JarvisTask => Boolean(item && typeof item.title === "string"))
      : [],
  };
}

async function makeBriefing(tasks: Awaited<ReturnType<typeof openTasks>>) {
  if (tasks.length === 0) {
    return "Good morning. Your task matrix is clear. There are no open commitments in the second brain.";
  }
  const raw = await callOpenRouter([
    {
      role: "system",
      content:
        "You are Jarvis. Produce a crisp British-voiced morning briefing in under 90 words. Prioritise overdue, due-today, and high-priority items. Return JSON only: {\"briefing\":\"...\"}.",
    },
    { role: "user", content: `Current time: ${new Date().toISOString()}\nOpen tasks:\n${JSON.stringify(tasks)}` },
  ]);
  const parsed = JSON.parse(cleanJson(raw)) as { briefing?: string };
  return parsed.briefing || "Your briefing is ready, but the summary channel returned no text.";
}

function errorResponse(error: unknown, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    if (body.config && typeof body.config === "object") {
      setRuntimeConfig(body.config as RuntimeConfig);
    }

    if (action === "status") {
      return NextResponse.json({ config: configStatus() });
    }

    if (action === "init") {
      return NextResponse.json({ ...(await createJarvisSession()), config: configStatus() });
    }

    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) return errorResponse(new Error("Missing Jarvis session ID."), 400);

    if (action === "briefing") {
      const tasks = await openTasks(sessionId);
      return NextResponse.json({ briefing: await makeBriefing(tasks), tasks });
    }

    if (action === "turn") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return errorResponse(new Error("I didn't catch that."), 400);

      await addWorkingTurn(sessionId, "user", text);
      const memory = await queryBoth(sessionId, text, 5);
      const result = await answerTurn(text, memory.working, memory.longTerm);
      await addWorkingTurn(sessionId, "assistant", result.response);
      const persisted = await persistTurn(sessionId, text, result.response, result.facts, result.tasks);

      return NextResponse.json({
        ...result,
        memoryMs: memory.elapsedMs,
        recalled: memory.working.length + memory.longTerm.length,
        persisted,
      });
    }

    return errorResponse(new Error("Unknown Jarvis action."), 400);
  } catch (error) {
    console.error("Jarvis API error", error);
    return errorResponse(error);
  }
}
