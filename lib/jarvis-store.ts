import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
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

type StoredDocument = DocumentInfo & { metadata?: Record<string, unknown> };

type JarvisSession = {
  id: string;
  startedAt: string;
  client: MossClient | null;
  localIndex: SessionIndex | null;
  working: StoredDocument[];
  documents: StoredDocument[];
  longTermIndex: string;
  memoryOnline: boolean;
  localMossReady: boolean;
  memoryError?: string;
};

type LocalStore = {
  version: 1;
  updatedAt: string;
  documents: StoredDocument[];
};

const globalState = globalThis as typeof globalThis & {
  __jarvisSessions?: Map<string, JarvisSession>;
};

const sessions = globalState.__jarvisSessions ?? new Map<string, JarvisSession>();
globalState.__jarvisSessions = sessions;

function dataDirectory() {
  return process.env.JARVIS_DATA_DIR?.trim() || path.join(process.cwd(), ".jarvis-data");
}

function memoryFile() {
  return path.join(dataDirectory(), "second-brain.json");
}

function localMossFile() {
  return path.join(dataDirectory(), "second-brain.moss");
}

function bootstrapDocument(): StoredDocument {
  return {
    id: "jarvis-memory-bootstrap",
    text: "Jarvis persistent second brain initialized.",
    metadata: { type: "system", createdAt: new Date().toISOString() },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function validDocument(value: unknown): value is StoredDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredDocument>;
  return typeof candidate.id === "string" && typeof candidate.text === "string";
}

function mergeDocuments(...groups: StoredDocument[][]) {
  const merged = new Map<string, StoredDocument>();
  for (const group of groups) {
    for (const doc of group) {
      if (validDocument(doc)) merged.set(doc.id, doc);
    }
  }
  return [...merged.values()];
}

async function readLocalDocuments() {
  try {
    const parsed = JSON.parse(await readFile(memoryFile(), "utf8")) as Partial<LocalStore>;
    const docs = Array.isArray(parsed.documents) ? parsed.documents.filter(validDocument) : [];
    return docs.length ? docs : [bootstrapDocument()];
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error("Jarvis local memory read failed", error);
    }
    return [bootstrapDocument()];
  }
}

async function writeLocalDocuments(documents: StoredDocument[]) {
  const directory = dataDirectory();
  const destination = memoryFile();
  const temporary = `${destination}.${process.pid}.tmp`;
  const payload: LocalStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    documents,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, destination);
}

function credentials() {
  const projectId = configValue("mossProjectId", "MOSS_PROJECT_ID");
  const projectKey = configValue("mossProjectKey", "MOSS_PROJECT_KEY");
  return projectId && projectKey ? { projectId, projectKey } : null;
}

function toMemory(
  docs: Array<{ id: string; text: string; score?: number; metadata?: Record<string, unknown> }>,
  source: RetrievedMemory["source"],
): RetrievedMemory[] {
  return docs.map((doc) => ({ ...doc, source }));
}

function tokens(value: string) {
  return new Set(value.toLowerCase().match(/[a-z0-9]{2,}/g) || []);
}

const EMBEDDING_DIMENSIONS = 384;

function hashFeature(value: string, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function localEmbedding(value: string) {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  const normalized = value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);
  const features = [
    ...words.map((word) => `w:${word}`),
    ...words.flatMap((word) => {
      const padded = `^${word}$`;
      return Array.from({ length: Math.max(0, padded.length - 2) }, (_, index) => `g:${padded.slice(index, index + 3)}`);
    }),
  ];

  for (const feature of features) {
    const bucket = hashFeature(feature) % EMBEDDING_DIMENSIONS;
    const sign = hashFeature(feature, 2246822519) % 2 === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0)) || 1;
  return vector.map((component) => component / magnitude);
}

function withoutEmbedding(doc: StoredDocument): StoredDocument {
  const { embedding: _embedding, ...rest } = doc;
  return rest;
}

function withEmbedding(doc: StoredDocument): StoredDocument {
  return { ...withoutEmbedding(doc), embedding: localEmbedding(doc.text) };
}

function createdAt(doc: StoredDocument) {
  const value = typeof doc.metadata?.createdAt === "string" ? Date.parse(doc.metadata.createdAt) : 0;
  return Number.isFinite(value) ? value : 0;
}

function searchLocal(documents: StoredDocument[], query: string, topK: number) {
  const queryTokens = tokens(query);
  return documents
    .filter((doc) => doc.metadata?.type !== "system")
    .map((doc) => {
      const docTokens = tokens(doc.text);
      let overlap = 0;
      for (const token of queryTokens) if (docTokens.has(token)) overlap += 1;
      return { ...doc, score: overlap + Math.min(0.99, createdAt(doc) / 1e15) };
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || createdAt(b) - createdAt(a))
    .slice(0, topK);
}

async function connectAndSyncMoss(indexName: string, localDocuments: StoredDocument[]) {
  const mossCredentials = credentials();
  if (!mossCredentials) {
    return {
      client: null,
      documents: localDocuments,
      memoryOnline: false,
      memoryError: "Moss credentials are not configured. Memories are safe on local disk.",
    };
  }

  const client = new MossClient(mossCredentials.projectId, mossCredentials.projectKey);
  let stage = "listing indexes";
  try {
    const indexes = await client.listIndexes();
    const existing = indexes.find((index) => index.name === indexName);
    const exists = Boolean(existing);
    let documents = localDocuments;

    if (exists) {
      stage = "reading the existing index";
      if (existing?.model.id !== "custom") {
        throw new Error(`Existing index '${indexName}' uses ${existing?.model.id || "an unknown model"}. Delete that one index once so Jarvis can recreate it with quota-free local embeddings.`);
      }
      const remoteDocuments = (await client.getDocs(indexName)).filter(validDocument).map(withoutEmbedding);
      const remoteById = new Map(remoteDocuments.map((doc) => [doc.id, JSON.stringify(doc)]));
      documents = mergeDocuments(remoteDocuments, localDocuments);
      const pending = documents.filter((doc) => remoteById.get(doc.id) !== JSON.stringify(doc));
      if (pending.length) {
        stage = "uploading locally embedded memories";
        await client.addDocs(indexName, pending.map(withEmbedding), { upsert: true });
      }
    } else {
      stage = "creating the locally embedded index";
      await client.createIndex(indexName, documents.map(withEmbedding), { modelId: "custom" });
    }

    stage = "loading the synchronized index";
    await client.loadIndex(indexName);
    await writeLocalDocuments(documents);
    return { client, documents, memoryOnline: true, memoryError: undefined };
  } catch (error) {
    return {
      client,
      documents: localDocuments,
      memoryOnline: false,
      memoryError: `Moss sync unavailable while ${stage}: ${errorMessage(error)}`,
    };
  }
}

async function createLocalMossIndex(client: MossClient | null, documents: StoredDocument[]) {
  if (!client) return { localIndex: null, localMossReady: false, localMossError: "Moss credentials are required for its local index engine." };
  try {
    const localIndex = await client.session("jarvis-local-second-brain", "custom");
    await localIndex.addDocs(documents.map(withEmbedding), { upsert: true });
    await localIndex.saveToDisk(localMossFile());
    return { localIndex, localMossReady: true, localMossError: undefined };
  } catch (error) {
    return { localIndex: null, localMossReady: false, localMossError: `Local Moss index unavailable: ${errorMessage(error)}` };
  }
}

export async function createJarvisSession() {
  const id = crypto.randomUUID();
  const longTermIndex = configValue("mossLongTermIndex", "MOSS_LONG_TERM_INDEX", "jarvis-second-brain");
  const localDocuments = await readLocalDocuments();
  await writeLocalDocuments(localDocuments);
  const moss = await connectAndSyncMoss(longTermIndex, localDocuments);
  const localMoss = await createLocalMossIndex(moss.client, moss.documents);

  const session: JarvisSession = {
    id,
    startedAt: new Date().toISOString(),
    client: moss.client,
    localIndex: localMoss.localIndex,
    working: [],
    documents: moss.documents,
    longTermIndex,
    memoryOnline: moss.memoryOnline,
    localMossReady: localMoss.localMossReady,
    memoryError: moss.memoryError || localMoss.localMossError,
  };
  sessions.set(id, session);

  return {
    id,
    workingIndex: "in-memory-recent-turns",
    longTermIndex,
    workingDocs: 0,
    memoryDocs: session.documents.length,
    memoryOnline: session.memoryOnline,
    localMossReady: session.localMossReady,
    memoryError: session.memoryError,
    memoryFile: memoryFile(),
    localMossFile: localMossFile(),
  };
}

export function getJarvisSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new Error("Jarvis session expired. Reinitialize the core.");
  return session;
}

export async function addWorkingTurn(sessionId: string, role: "user" | "assistant", text: string) {
  const session = getJarvisSession(sessionId);
  const createdAtValue = new Date().toISOString();
  session.working.push({
    id: `turn-${createdAtValue}-${crypto.randomUUID()}`,
    text: `${role === "user" ? "User" : "Jarvis"}: ${text}`,
    metadata: { type: "conversation-turn", role, createdAt: createdAtValue },
  });
  session.working = session.working.slice(-40);
}

export async function queryBoth(sessionId: string, query: string, topK = 5) {
  const session = getJarvisSession(sessionId);
  const started = performance.now();
  const working = searchLocal(session.working, query, topK);
  let longTerm: Array<StoredDocument & { score?: number }> = searchLocal(session.documents, query, topK);

  if (session.localIndex) {
    try {
      const localResult = await session.localIndex.query(query, { topK, embedding: localEmbedding(query) });
      longTerm = localResult.docs;
    } catch (error) {
      session.localMossReady = false;
      session.memoryError = `Local Moss query unavailable: ${errorMessage(error)}`;
    }
  }

  if (session.client && session.memoryOnline) {
    try {
      const mossResult = await session.client.query(session.longTermIndex, query, { topK, embedding: localEmbedding(query) });
      longTerm = mergeDocuments(
        mossResult.docs.filter(validDocument),
        longTerm,
      ).slice(0, topK);
    } catch (error) {
      session.memoryOnline = false;
      session.memoryError = `Moss query unavailable: ${errorMessage(error)}`;
    }
  }

  return {
    working: toMemory(working, "working"),
    longTerm: toMemory(longTerm, "long-term"),
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
    memoryOnline: session.memoryOnline,
    localMossReady: session.localMossReady,
    memoryError: session.memoryError,
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
  const docs: StoredDocument[] = [
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

  const latestLocal = await readLocalDocuments();
  session.documents = mergeDocuments(latestLocal, session.documents, docs);
  await writeLocalDocuments(session.documents);

  if (session.localIndex) {
    try {
      await session.localIndex.addDocs(docs.map(withEmbedding), { upsert: true });
      await session.localIndex.saveToDisk(localMossFile());
      session.localMossReady = true;
    } catch (error) {
      session.localMossReady = false;
      session.memoryError = `Local Moss write unavailable: ${errorMessage(error)}`;
    }
  }

  if (session.client && session.memoryOnline) {
    try {
      const mutation = await session.client.addDocs(session.longTermIndex, docs.map(withEmbedding), { upsert: true });
      await session.client.loadIndex(session.longTermIndex);
      return {
        stored: session.documents.length,
        synced: true,
        localMossReady: session.localMossReady,
        mossDocCount: mutation.docCount,
        tasksAdded: tasks.length,
      };
    } catch (error) {
      session.memoryOnline = false;
      session.memoryError = `Moss write unavailable: ${errorMessage(error)}`;
    }
  }

  return {
    stored: session.documents.length,
    synced: false,
    localMossReady: session.localMossReady,
    tasksAdded: tasks.length,
    error: session.memoryError || "Moss is offline; this memory is stored locally and will sync later.",
  };
}

export async function openTasks(sessionId: string) {
  const session = getJarvisSession(sessionId);
  return session.documents
    .filter((doc) => doc.metadata?.type === "task" && doc.metadata?.status === "open")
    .map((doc) => ({
      id: doc.id,
      title: doc.text,
      due: String(doc.metadata?.due || "unscheduled"),
      recurrence: String(doc.metadata?.recurrence || "none"),
      priority: String(doc.metadata?.priority || "normal"),
    }));
}
