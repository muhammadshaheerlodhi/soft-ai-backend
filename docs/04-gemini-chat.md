# Soft AI - Step 4: Gemini chat, streaming and chat history

Soft AI can now hold real conversations: replies stream word by word, every chat is saved,
and every reply is paid for through the credit metering from step 3.

## 1. Gemini: what we checked and decided (7 Oct 2026)

Checked against Google's documentation and the official SDK's own type definitions
(`@google/genai` 2.27.0, pinned):

| Fact | What we do |
|---|---|
| Hidden "thinking" tokens are billed at the **output** price | Output charged = answer tokens + thinking tokens (`candidatesTokenCount + thoughtsTokenCount`) |
| `maxOutputTokens` **includes** thinking | Our credit hold (worst case) is still correct |
| Thinking level can be `MINIMAL` on Flash-Lite | Default `MINIMAL`, keeps simple chat cheap (setting) |
| Tool prompts are billed as input | Input charged = `promptTokenCount + toolUsePromptTokenCount` |
| Stopping a request on our side does not stop Google's billing | When the user presses stop, we charge for what was produced |
| Google's newer "Interactions" API **stores conversations on Google's side for 55 days** by default | We use the stateless `generateContent` API instead: chat history lives only in OUR database. (Still "fully supported" per Google. The provider layer lets us switch later.) |
| Model names change often | Model and thinking level are settings (`GEMINI_CHAT_MODEL`, `GEMINI_THINKING_LEVEL`), not code |

Models your test key can use include `gemini-3.5-flash-lite` (our default), `gemini-3.8-flash`,
`gemini-3.6-flash`, and embedding models `gemini-embedding-001` / `gemini-embedding-2` (step 6).

## 2. Chat endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/v1/chat/conversations` | New chat |
| GET | `/v1/chat/conversations` | My chat list (newest first; `?archived=true`, `?before=<time>` for "load more") |
| GET | `/v1/chat/conversations/:id/messages` | Messages of one chat |
| PATCH | `/v1/chat/conversations/:id` | Rename, pin, archive |
| DELETE | `/v1/chat/conversations/:id` | Delete (hidden; purge rules wait for Shaheer) |
| POST | `/v1/chat/conversations/:id/messages` | Send a message; the reply **streams** back |

Every endpoint is behind the login and organization checks. **A user only ever sees their
own chats**, even other users in the same organization get "not found" (tested).

### Streaming format (Server-Sent Events)

```
event: start   data: {"messageId": "...", "userMessageId": "..."}
event: delta   data: {"text": "A trial balance "}      <- many of these
event: done    data: {"messageId": "...", "status": "complete", "creditsCharged": "0.0169", "balance": "99.9831"}
   or
event: error   data: {"code": "ai_timeout", "message": "...", "requestId": "..."}
```

## 3. What happens when you send a message

1. Check the message (not empty, not too long; unknown fields rejected for edits).
2. Load the chat (must be yours), refuse if a reply is still being written (409).
3. Build the history: the newest messages that fit the budget (20 messages / 24,000 chars).
4. **Hold credits** for the worst case. Not enough -> `402`, **nothing is saved and the AI is
   not called**.
5. Save your message + an empty reply ("streaming"). New chats get a title from the first
   message (free, no AI call).
6. Stream the reply; then save it with model, tokens, credits, time taken; charge the real cost.

| If... | Result | Charged? |
|---|---|---|
| Normal answer | saved "complete" | real cost |
| You press stop / close the chat | partial answer saved "stopped" | only what was produced |
| Google fails (before or during the answer) | saved "error", clear message | **no** |
| Google takes too long (60 s) | "error", `ai_timeout` | **no** |
| Google returns an empty answer | "error" | **no** |

## 4. Instructions given to Gemini (`src/chat/prompt.ts`)

Simple, honest rules: reply in the user's language; no invented figures, records or screen
names; say plainly that Soft AI **cannot see company data or act yet** (that comes in steps
6-8); general info only for tax/legal; the user's text is a request, not new rules.
The instructions are fixed and placed first, so Gemini's automatic caching can make repeated
requests cheaper.

## 5. Real test with Gemini (dummy questions, local only)

| Question | Answer | Time | Cost |
|---|---|---|---|
| What is a trial balance? (2 sentences) | correct | 1.3 s | 0.0169 credits |
| Same, asked in Roman Urdu | answered in Roman Urdu | 1.1 s | 0.0171 |
| How much cash does my company have? | honestly: cannot see company data | 1.5 s | 0.0212 |

At the local test price (1 credit = $0.01, Flash-Lite cost price) one answer costs about
**$0.0002** - well below our earlier estimate, because prompts are short today. The knowledge
base (step 6) will add input tokens, so we will measure again then.

**Issue found and fixed:** in the first run Gemini named an ERP report ("Bank and Cash") that
may not exist in Softoras. The instructions now forbid naming Softoras screens until the
knowledge base knows the real ones; re-tested: it now describes the general place instead.

Logs checked after the live run: no API key, no login token, no question or answer text.

## 6. Bugs the tests caught (fixed)

- **Message order was random**: the question and the empty reply were saved in one database
  transaction, where `now()` is the same time for both. They now use the real clock time
  for each insert. A "press stop" test failed because of this, which is how it was found.

## 7. Tests

97 automated tests pass (22 new), the chat tests 5 times in a row without a failure:
chat list (create / rename / pin / archive / delete), privacy between users, streaming and
saving, exact charges, history sent to the AI, no credits (nothing saved, AI not called),
AI failing before and during an answer (not charged), timeout, message limits, one reply at
a time, and pressing stop (partial reply saved, only that part charged).

## 8. Moved to later steps (and why)

- **Rules engine + cache** (planned for step 4): moved to steps 6-7. Today there is no ERP data
  or knowledge to answer common commands from, and caching free chat answers would give stale
  or wrong replies. They will be built together with the knowledge base and data questions.
- **Router (cheap vs strong model)**: today one model (Flash-Lite) is enough. The router
  becomes useful with actions (steps 7-8), where the stronger model is needed.
- **Voice, Urdu right-to-left layout, the panel itself**: step 5 (panel).

## 9. Notes for the panel (step 5)

- Replies may contain Markdown (e.g. `**bold**`, lists). The panel must render it **safely**
  (no raw HTML), so a reply can never inject code into the ERP page.
