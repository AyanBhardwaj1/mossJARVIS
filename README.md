# J.A.R.V.I.S.

Jarvis is a voice-activated personal AI assistant with a compact Iron Man-inspired HUD and a persistent “second brain.” It listens locally for the word **Jarvis**, transcribes the following command on-device, recalls relevant short- and long-term context through Moss, generates an answer through OpenRouter, stores useful facts and tasks back in Moss, and speaks the answer with ElevenLabs.

The repository can run as:

- a browser development application at `http://localhost:3000`; or
- a frameless, transparent, always-on-top Tauri desktop overlay.

## Feature status

| Capability | Implementation |
| --- | --- |
| Wake word | Local Picovoice Porcupine Web model using the built-in `Jarvis` keyword |
| Speech-to-text | Local Picovoice Cheetah streaming transcription with endpoint detection |
| Conversational reasoning | OpenRouter Chat Completions with a configurable model |
| Live conversational memory | Moss `SessionIndex` containing the current interaction's turns |
| Persistent second brain | Moss cloud-backed index containing summaries, facts, preferences, and tasks |
| Task capture | OpenRouter returns structured tasks; Jarvis stores them as Moss documents with metadata |
| Morning briefing | Reads open task documents from Moss and asks OpenRouter to produce a concise spoken briefing |
| Speech output | ElevenLabs text-to-speech, with browser/OS speech synthesis as a development fallback |
| Desktop shell | Tauri 2 frameless, transparent, resizable, always-on-top window |
| Text fallback | HUD command bar sends the same turns through the full Moss → OpenRouter → Moss pipeline |
| Runtime configuration | Masked in-app credential form plus `.env.local` support |

## What each component contributes

### Moss: memory, retrieval, and synchronization

Moss is the foundation of Jarvis's second brain. It is not the language model and does not generate Jarvis's responses. Moss is responsible for turning memory documents into a locally searchable index and making those documents available across future sessions.

In this project Moss contributes:

1. **Local embeddings.** Documents added to a `SessionIndex` are embedded by Moss's bundled Rust runtime using the default `moss-minilm` model. Jarvis does not call OpenAI or another embedding API.
2. **Short-term working memory.** The current conversation is written into a local Moss session with `addDocs()` and searched with `query()`.
3. **Long-term semantic memory.** The stable `jarvis-second-brain` index holds durable conversation records, extracted facts, preferences, and task documents.
4. **Retrieval before every answer.** Jarvis searches both the working session and the loaded long-term index in parallel. The top five results from each source are included in the OpenRouter prompt.
5. **Local query execution.** After the long-term index is loaded with `loadIndex()`, retrieval runs in the application process rather than making a network round trip for every query.
6. **Metadata-bearing documents.** Facts, conversation records, system records, and tasks are differentiated using document metadata. Task metadata makes the memory filterable by fields such as type, status, due date, recurrence, and priority.
7. **Cloud persistence.** New long-term documents are first added locally, then uploaded with `pushIndex()`. Moss persists the index under its stable name so another process or future Jarvis session can resume it.
8. **Hydration and refresh.** Jarvis loads the cloud index at startup and reloads it after a push so `MossClient.query()` sees the latest durable state.
9. **Retrieval telemetry.** Query duration and retrieved-document counts are exposed in the HUD as Moss latency and memory recall metrics.

This follows Moss's documented **create/resume → mutate locally → query locally → push** lifecycle. See the [Moss sessions guide](https://docs.moss.dev/docs/integrate/sessions) and [live-call context guide](https://docs.moss.dev/docs/build/live-call-context).

### What Moss does not do here

Clear ownership matters:

- Moss does **not** decide what Jarvis says; OpenRouter does.
- Moss does **not** extract facts or interpret “remind me”; the OpenRouter response provides structured facts and tasks.
- Moss does **not** listen to the microphone; Picovoice does.
- Moss does **not** synthesize audio; ElevenLabs does.
- Moss is not currently used as a clock-based notification scheduler. It stores task state and makes it retrievable for briefings.
- Open task selection currently calls `longTerm.getDocs()` and filters the returned metadata in the Node process. The documents are compatible with Moss metadata filters, but the current briefing path does not yet issue a filtered Moss query.

### OpenRouter: reasoning and structured extraction

All conversational model calls go through OpenRouter. The model receives:

- the current user command;
- relevant documents retrieved from the live Moss session;
- relevant documents retrieved from the persistent Moss index; and
- instructions to return strict JSON containing a spoken response, durable facts, and structured tasks.

The expected response shape is:

```json
{
  "response": "Certainly. I have added that to your task matrix.",
  "facts": ["The user prefers morning meetings."],
  "tasks": [
    {
      "title": "Send the project update",
      "due": "2026-07-12T09:00:00+05:30",
      "recurrence": "none",
      "priority": "high"
    }
  ]
}
```

Jarvis validates this structure before storing it. The model is configured with `OPENROUTER_MODEL`, so it can be replaced without changing code.

### Picovoice: local audio intelligence

Two Picovoice Web SDKs form the input side of the voice loop:

- **Porcupine** continuously processes microphone frames locally and invokes Jarvis when it detects the built-in `Jarvis` keyword.
- **Cheetah** takes over after the wake word, streams partial transcription into the HUD, and marks the utterance complete after approximately 1.15 seconds of endpoint silence.

The included files are:

- `public/models/porcupine_params.pv`
- `public/models/cheetah_params.pv`

The first initialization is slower because the 34 MB Cheetah model must be loaded and cached by the browser. Speech processing runs locally after the model is loaded, but Picovoice still requires an AccessKey for SDK authorization.

### ElevenLabs: spoken output

`POST /api/jarvis/tts` sends the final response to ElevenLabs and returns MP3 audio to the HUD. The default configuration uses:

- voice ID `JBFqnCBsd6RMkjVDRZzb` (George); and
- model `eleven_multilingual_v2`.

If ElevenLabs is missing or playback fails, the development UI attempts to use the operating system's `en-GB` speech-synthesis voice. That fallback is useful for testing but is not equivalent to ElevenLabs quality.

### Next.js: application and orchestration layer

Next.js provides both the React HUD and the Node.js API routes. The server layer owns the in-memory Jarvis session registry, calls Moss, OpenRouter, and ElevenLabs, and returns sanitized state to the client. Credentials loaded from `.env.local` remain server-side; credentials entered through the optional in-app form are explicitly sent from browser storage to the local server at runtime.

### Tauri: desktop window

Tauri wraps the Next.js application in a native macOS window configured as:

- frameless;
- transparent;
- resizable;
- always on top; and
- draggable through the custom HUD title bar.

The production build bundles Next.js standalone output as a Tauri resource. The current packaged design launches that server with the target machine's system `node` executable, so Node.js 20+ remains a runtime requirement.

## End-to-end voice turn

```text
1. Microphone frames
        │
        ▼
2. Porcupine detects “Jarvis” locally
        │
        ▼
3. Cheetah streams local transcription
        │
        ▼
4. POST /api/jarvis { action: "turn" }
        │
        ├── add user turn to Moss working SessionIndex
        │
        ├── query working SessionIndex (top 5)
        │
        └── query loaded long-term Moss index (top 5)
                    │
                    ▼
5. Combined retrieved context → OpenRouter
                    │
                    ▼
6. JSON response: spoken answer + facts + tasks
        │
        ├── add assistant turn to working SessionIndex
        │
        ├── add conversation record to long-term SessionIndex
        │
        ├── add extracted fact documents
        │
        ├── add structured task documents
        │
        ├── pushIndex() to Moss Cloud
        │
        └── loadIndex() to refresh the local durable runtime
                    │
                    ▼
7. Answer → ElevenLabs → MP3 → speaker
```

The text command bar begins at step 4 and otherwise uses the identical pipeline.

## Moss memory model in detail

The implementation lives in [`lib/jarvis-store.ts`](./lib/jarvis-store.ts).

### Working session: short-term context

```ts
const working = await client.session(`jarvis-working-${dayKey()}`);
```

Each user and assistant turn is stored as a document like:

```json
{
  "id": "turn-...",
  "text": "User: Remind me to send the update tomorrow morning.",
  "metadata": {
    "type": "conversation-turn",
    "role": "user",
    "createdAt": "2026-07-11T02:00:00.000Z"
  }
}
```

The working session is intentionally not pushed after every turn. It is short-lived context for the active API session. Durable information from the exchange is written separately into the second-brain session. Consequently, raw working turns do not currently survive a process restart unless a cloud index with that working-session name was created elsewhere.

### Long-term session: durable second brain

```ts
const longTerm = await client.session("jarvis-second-brain");
await client.loadIndex("jarvis-second-brain");
```

`client.session(name)` is create-or-resume: Moss loads the existing cloud index when it exists and otherwise starts with an empty session. On a new account, Jarvis adds a bootstrap system document and pushes it to create the long-term cloud index.

After each successful model turn, Jarvis adds:

- one complete user/assistant conversation record;
- zero or more durable fact documents; and
- zero or more structured task documents.

It then calls:

```ts
await longTerm.addDocs(documents);
await longTerm.pushIndex();
await client.loadIndex("jarvis-second-brain");
```

This makes the new memory durable and refreshes the locally queryable long-term index.

### Parallel retrieval

Before OpenRouter generates an answer, Jarvis performs:

```ts
const [working, longTerm] = await Promise.all([
  session.working.query(userText, { topK: 5 }),
  session.client.query(session.longTermIndex, userText, { topK: 5 }),
]);
```

Results carry a `working` or `long-term` source label so the prompt preserves the memory boundary. Moss relevance scores are available on the returned documents; Jarvis currently passes the retrieved text and source into the model prompt.

### Memory document types

| `metadata.type` | Purpose | Typical lifetime |
| --- | --- | --- |
| `system` | Second-brain bootstrap and system records | Permanent |
| `conversation-turn` | Raw user or assistant turn in working memory | Active process/session |
| `conversation-summary` | Durable record of a completed exchange | Permanent |
| `fact` | Extracted user preference or durable personal fact | Permanent |
| `task` | Action item used by the task matrix and morning briefing | Until its status changes |

Current task documents use:

```json
{
  "id": "task-...",
  "text": "Send the project update",
  "metadata": {
    "type": "task",
    "status": "open",
    "due": "2026-07-12T09:00:00+05:30",
    "recurrence": "none",
    "priority": "high",
    "createdAt": "2026-07-11T02:00:00.000Z"
  }
}
```

Moss evaluates metadata filtering on a locally loaded index. This schema is ready for queries such as open tasks, overdue tasks, or recurring tasks using Moss filters. See [Moss metadata filtering](https://docs.moss.dev/docs/integrate/metadata-filtering).

## Morning briefing

The morning briefing path is deliberately separate from a normal turn:

1. `openTasks()` reads documents from the long-term Moss session.
2. Jarvis keeps documents with `metadata.type === "task"` and `metadata.status === "open"`.
3. OpenRouter receives the structured open-task list and current timestamp.
4. The resulting briefing prioritizes overdue, due-today, and high-priority items.
5. ElevenLabs speaks the briefing.

When no task documents are open, Jarvis returns a deterministic no-tasks briefing without spending an OpenRouter request.

## Project structure

```text
app/
├── page.tsx                    HUD, state machine, settings, transcript, audio playback
├── globals.css                 HUD visuals and state-specific reactor animations
└── api/jarvis/
    ├── route.ts                Init, status, turn, briefing, OpenRouter orchestration
    └── tts/route.ts            ElevenLabs text-to-speech proxy

lib/
├── jarvis-store.ts             Moss client, sessions, dual retrieval, persistence, tasks
├── runtime-config.ts           Runtime provider configuration and environment fallback
└── voice-engine.ts             Porcupine/Cheetah worker lifecycle and microphone routing

public/models/
├── porcupine_params.pv         Local wake-word parameters
└── cheetah_params.pv           Local streaming STT parameters

src-tauri/
├── src/lib.rs                  Native server process and HUD window creation
├── tauri.conf.json             Tauri build, bundle, security, and resource configuration
└── capabilities/default.json   Window permissions
```

## Requirements

- Node.js 20 or newer
- npm; pnpm also works
- Rust stable
- [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/)
- Moss project credentials
- OpenRouter API key with access to the configured model
- ElevenLabs API key with text-to-speech permission
- Picovoice AccessKey
- Microphone permission
- Internet access for Moss synchronization, OpenRouter generation, and ElevenLabs speech

Wake-word detection and speech-to-text run locally after the Picovoice models have initialized. Moss queries run locally after index hydration, but opening/pushing a cloud index requires network access.

## Installation

```bash
git clone <repository-url>
cd <repository-directory>
npm install
cp .env.local.example .env.local
```

### Credential option A: `.env.local`

Fill in:

```env
MOSS_PROJECT_ID=your_project_id
MOSS_PROJECT_KEY=your_project_key
MOSS_LONG_TERM_INDEX=jarvis-second-brain

OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=openai/gpt-4.1-mini

ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_MODEL_ID=eleven_multilingual_v2

NEXT_PUBLIC_PICOVOICE_ACCESS_KEY=your_picovoice_access_key

JARVIS_TIMEZONE=Asia/Kolkata
APP_URL=http://localhost:3000
```

Restart the development server after changing `.env.local`.

### Credential option B: in-app configuration

Open **CONFIG** or the top-right settings control. Enter the credentials and select **SAVE KEYS & INITIALIZE CORE**.

Runtime configuration behavior:

- values are stored in the current browser's `localStorage`;
- values are sent to the local `/api/jarvis` route and retained in server memory;
- non-empty runtime values override `.env.local` values for the current process;
- a blank runtime field leaves an existing server environment value unchanged;
- the Moss session is initialized immediately, without restarting Next.js; and
- credentials must be re-injected from browser storage after the Node process restarts.

The masked inputs prevent shoulder surfing, but `localStorage` is not encrypted secret storage. For stricter server-side secrecy, use `.env.local`. `NEXT_PUBLIC_PICOVOICE_ACCESS_KEY` is necessarily available to the browser because the Picovoice Web SDK runs client-side.

## Running Jarvis

### Browser development mode

```bash
npm run dev
```

Open `http://localhost:3000`.

### Tauri desktop mode

```bash
npm run desktop
```

The first Rust/Tauri compilation can take several minutes and requires multiple gigabytes of free disk space.

### First voice activation

1. Complete the System Configuration panel.
2. Click **ARM VOICE** or the central reactor.
3. Allow microphone access.
4. Wait for `WAKE LINK ARMED`.
5. Say “Jarvis.”
6. Speak a command and pause naturally.

## Production build

```bash
npm run desktop:build
```

This command:

1. creates Next.js standalone output;
2. copies static and public assets into the standalone server;
3. bundles that server as a Tauri resource; and
4. builds the native application bundle.

The current native launcher executes `node server.js`, so the target machine must have Node.js 20+ available on its system PATH.

## API contract

All Jarvis orchestration uses `POST /api/jarvis`.

| Action | Required fields | Result |
| --- | --- | --- |
| `status` | optional `config` | Boolean provider-link status; never returns secret values |
| `init` | optional `config` | Opens Moss sessions and returns session/index/document metadata |
| `turn` | `sessionId`, `text` | Returns answer, extracted facts/tasks, recall count, Moss latency, and push count |
| `briefing` | `sessionId` | Returns the spoken briefing and current open tasks |

`POST /api/jarvis/tts` accepts `{ "text": "..." }` and returns `audio/mpeg` when ElevenLabs succeeds.

## Network and privacy boundaries

| Data | Destination | Reason |
| --- | --- | --- |
| Raw microphone frames | Local Porcupine/Cheetah Web Workers | Wake detection and transcription |
| User transcript | Local Next.js API, Moss Cloud during pushed persistence, OpenRouter | Memory, retrieval, and response generation |
| Retrieved Moss context | OpenRouter | Grounding the response in relevant memory |
| Conversation record, extracted facts, tasks | Moss Cloud on `pushIndex()` | Persistence across restarts/devices |
| Final response text | ElevenLabs | Speech synthesis |
| Runtime credentials entered in the UI | Browser `localStorage` and local Next.js process | Runtime provider configuration |

Do not expose this development server to an untrusted network while using browser-stored provider keys.

## Failure behavior

| Failure | UI behavior |
| --- | --- |
| Missing/invalid Moss credentials | Core enters red `OFFLINE`; configuration panel opens |
| Missing OpenRouter key | Moss can initialize, but conversational turns fail before generation |
| Missing ElevenLabs key | Browser/OS speech synthesis is attempted as a fallback |
| Missing Picovoice key | Text commands still work; wake-word initialization opens configuration |
| Microphone denied | Text command bar remains available |
| Session lost after server restart | Reopen/re-save configuration to create a new Jarvis API session |
| Moss push failure | Turn reports an error rather than pretending memory persisted |

## Current limitations

- Task completion, editing, and deletion are not yet exposed in the HUD.
- Tasks are memory documents, not operating-system notifications or background alarms.
- Recurrence is stored but not expanded into future task instances.
- The current working session is not pushed at shutdown; durable records are written to the long-term index after successful model turns.
- Conversation “summaries” currently store the complete user/assistant exchange rather than a separately compressed summary.
- There is no account/user namespace beyond the configured Moss project and index name.
- Runtime credentials use browser storage rather than the macOS Keychain or Tauri Stronghold.
- The native production server depends on a system Node.js installation.

## Troubleshooting

### The HUD says `MOSS CREDENTIALS REQUIRED`

Open **CONFIG**, enter both the Moss Project ID and Project Key, and save. Moss validates credentials when opening a session.

### Settings say OpenRouter is linked, but turns fail

Confirm that the configured OpenRouter account has credits and access to `OPENROUTER_MODEL`. A linked status only means a key exists; it does not make a paid provider request during the status check.

### Voice initialization takes a long time

The Cheetah model is approximately 34 MB. The initial browser load and IndexedDB cache write can be noticeably slower than later starts.

### The central reactor is red

Read the status line directly under it. Red indicates missing credentials, provider validation failure, or an API error; it is not merely a decorative state.

### Tauri cannot compile

Verify:

```bash
node --version
npm --version
rustc --version
cargo --version
```

Then confirm the platform dependencies in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/). The first build needs several gigabytes of free disk space.

## Validation commands

```bash
npm run typecheck
npm run build
```

## Primary references

- [Moss sessions](https://docs.moss.dev/docs/integrate/sessions)
- [Moss live-call context](https://docs.moss.dev/docs/build/live-call-context)
- [Moss metadata filtering](https://docs.moss.dev/docs/integrate/metadata-filtering)
- [Moss JavaScript SDK reference](https://docs.moss.dev/docs/reference/js/api)
- [Moss repository and ElevenLabs example](https://github.com/usemoss/moss/tree/main/apps/elevenlabs-moss)
- [Porcupine Web quick start](https://picovoice.ai/docs/quick-start/porcupine-web/)
- [Cheetah Web quick start](https://picovoice.ai/docs/quick-start/cheetah-web/)
- [OpenRouter quick start](https://openrouter.ai/docs/quickstart)
- [ElevenLabs text-to-speech endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
- [Tauri 2 configuration reference](https://v2.tauri.app/reference/config/)
