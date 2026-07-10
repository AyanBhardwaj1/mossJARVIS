import { MossClient, type DocumentInfo, type SessionIndex } from "@moss-dev/moss";
import { configValue } from "@/lib/runtime-config";

export type JarvisTask = {
  title: string;
  due?: string;
  recurrence?: string;
  priority?: "low" | "normal" | "high";
};

export type RetrievedMemory = {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
  source: "working" | "long-term";
};

type JarvisSession = {
  id: string;
  startedAt: string;
  client: MossClient;
  working: SessionIndex;
  longTerm: SessionIndex;
  longTermIndex: string;
};

const globalState = globalThis as typeof globalThis & {
  __jarvisSessions?: Map<string, JarvisSession>;
};

const sessions = globalState.__jarvisSessions ?? new Map<string, JarvisSession>();
globalState.__jarvisSessions = sessions;

function credentials() {
  const projectId = configValue("mossProjectId", "MOSS_PROJECT_ID");
  const projectKey = configValue("mossProjectKey", "MOSS_PROJECT_KEY");
  if (!projectId || !projectKey) {
    throw new Error("Moss is offline. Add MOSS_PROJECT_ID and MOSS_PROJECT_KEY to .env.local.");
  }
  return { projectId, projectKey };
}

function dayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.JARVIS_TIMEZONE || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function toMemory(
  docs: Array<{ id: string; text: string; score?: number; metadata?: Record<string, unknown> }>,
  source: RetrievedMemory["source"],
): RetrievedMemory[] {
  return docs.map((doc) => ({ ...doc, source }));
}

export async function createJarvisSession() {
  const { projectId, projectKey } = credentials();
  const client = new MossClient(projectId, projectKey);
  const id = crypto.randomUUID();
  const longTermIndex = configValue("mossLongTermIndex", "MOSS_LONG_TERM_INDEX", "jarvis-second-brain");

  // Sessions are create-or-resume. The day-scoped name gives the current
  // conversation a stable working set while keeping it separate from memory.
  const working = await client.session(`jarvis-working-${dayKey()}`);
  const longTerm = await client.session(longTermIndex);

  // Explicitly hydrate the persistent index into Moss's local runtime. A new
  // account starts with one bootstrap document, then follows mutate -> push.
  if (longTerm.docCount === 0) {
    await longTerm.addDocs([
      {
        id: "jarvis-memory-bootstrap",
        text: "Jarvis persistent second brain initialized.",
        metadata: { type: "system", createdAt: new Date().toISOString() },
      },
    ]);
    await longTerm.pushIndex();
  }
  await client.loadIndex(longTermIndex);

  const session: JarvisSession = {
    id,
    startedAt: new Date().toISOString(),
    client,
    working,
    longTerm,
    longTermIndex,
  };
  sessions.set(id, session);

  return {
    id,
    workingIndex: working.name,
    longTermIndex,
    workingDocs: working.docCount,
    memoryDocs: longTerm.docCount,
  };
}

export function getJarvisSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error("Jarvis session expired. Reinitialize the core.");
  return session;
}

export async function addWorkingTurn(sessionId: string, role: "user" | "assistant", text: string) {
  const session = getJarvisSession(sessionId);
  const createdAt = new Date().toISOString();
  await session.working.addDocs([
    {
      id: `turn-${createdAt}-${crypto.randomUUID()}`,
      text: `${role === "user" ? "User" : "Jarvis"}: ${text}`,
      metadata: { type: "conversation-turn", role, createdAt },
    },
  ]);
}

export async function queryBoth(sessionId: string, query: string, topK = 5) {
  const session = getJarvisSession(sessionId);
  const started = performance.now();
  const [working, longTerm] = await Promise.all([
    session.working.query(query, { topK }),
    session.client.query(session.longTermIndex, query, { topK }),
  ]);

  return {
    working: toMemory(working.docs, "working"),
    longTerm: toMemory(longTerm.docs, "long-term"),
    elapsedMs: Math.max(
      working.timeTakenInMs ?? 0,
      longTerm.timeTakenInMs ?? 0,
      Math.round((performance.now() - started) * 10) / 10,
    ),
  };
}

export async function persistTurn(
  sessionId: string,
  userText: string,
  response: string,
  facts: string[],
  tasks: JarvisTask[],
) {
  const session = getJarvisSession(sessionId);
  const now = new Date().toISOString();
  const docs: DocumentInfo[] = [
    {
      id: `memory-${crypto.randomUUID()}`,
      text: `Conversation ${now}. User: ${userText}\nJarvis: ${response}`,
      metadata: { type: "conversation-summary", createdAt: now },
    },
    ...facts.filter(Boolean).map((fact) => ({
      id: `fact-${crypto.randomUUID()}`,
      text: fact,
      metadata: { type: "fact", createdAt: now },
    })),
    ...tasks.map((task) => ({
      id: `task-${crypto.randomUUID()}`,
      text: task.title,
      metadata: {
        type: "task",
        status: "open",
        due: task.due || "unscheduled",
        recurrence: task.recurrence || "none",
        priority: task.priority || "normal",
        createdAt: now,
      },
    })),
  ];

  // Moss session lifecycle: mutate locally, query locally (done before the
  // model call), then push the complete long-term session back to the cloud.
  await session.longTerm.addDocs(docs);
  const pushed = await session.longTerm.pushIndex();
  await session.client.loadIndex(session.longTermIndex);
  return { pushed: pushed.docCount, tasksAdded: tasks.length };
}

export async function openTasks(sessionId: string) {
  const session = getJarvisSession(sessionId);
  const docs = await session.longTerm.getDocs();
  return docs
    .filter((doc) => doc.metadata?.type === "task" && doc.metadata?.status === "open")
    .map((doc) => ({
      id: doc.id,
      title: doc.text,
      due: String(doc.metadata?.due || "unscheduled"),
      recurrence: String(doc.metadata?.recurrence || "none"),
      priority: String(doc.metadata?.priority || "normal"),
    }));
}
