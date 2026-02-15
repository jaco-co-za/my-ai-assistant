# LLM Integration Guide (Copy From mss-homeassistant)

This service does not yet have LLM orchestration. Use the implementation in
`E:\Source\LLMS\mss-homeassistant\src\homeAssistant.ts` as the source of truth.
The goal is to add:

- LLM prompt execution for command parsing/selection
- Learning extraction and storage
- Learning-aware prompt augmentation

Follow the steps below to copy the functionality in a minimal, safe way.

**1) Create prompt templates**

- Add a top-level `prompts/` directory.
- Each prompt is JSON with keys: `name`, `version`, `instructions` (array of
  wrapped lines), and `output_schema`.
- Use the prompt format already used in `mss-homeassistant/prompts/*.json`.
- At minimum, you need:
  - `prompts/learnings_extract.json`
  - `prompts/learnings_sql.json`
  - Any command/tool prompts your email service requires

**2) Add LLM caller**

- Copy `sendToAssistant` from
  `E:\Source\LLMS\mss-homeassistant\src\homeAssistant.ts`.
- Keep model selection:
  - Base model: `qwen2.5:14b` via `ASSISTANT_MODEL` (default)
  - SQL-only model: `qwen2.5-coder:14b` for SQLite query generation
- Input payload format is the same as the home-assistant service:
  - `system` + `user` message, `format: "json"`, `temperature: 0.2`
- Expected response is a JSON string wrapped in the assistant envelope.

**3) Add learning storage**

- Create `learnings.db` at the service root.
- Use the schema from `mss-homeassistant`:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `content TEXT NOT NULL`
  - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
- Use SQLite CLI or `sqlite3` package to create/insert/read.

Reference functions to copy:

- `ensureLearningsDb`
- `refreshLearnings`
- `appendLearning`
- `parseLearningExtract`

**4) Add learning detection + SQL tool**

- Add a learnings decision prompt:
  - Use `prompts/learnings_sql.json`
  - Call it with `qwen2.5-coder:14b`
  - Output: `{ action: "list" | "delete" | "none", sql: string }`
- Enforce a SQL safety gate:
  - Only allow `SELECT` or `DELETE` from `learnings`
  - Reject everything else

Reference functions to copy:

- `buildLearningsSqlPrompt`
- `parseLearningsSql`
- `isSafeLearningsSql`
- `runLearningsSql`
- `formatLearningsRows`

**5) Learnings injection (only when relevant)**

- Include learnings in prompts only when a learning shares a non-stopword
  token with the request payload.
- Reuse the stopword filter and matcher from
  `mss-homeassistant/src/homeAssistant.ts`:
  - `STOP_WORDS`
  - `tokenizeText`
  - `learningTokensMatchPrompt`

**6) Learning intent**

- Only attempt learning extraction if the user is teaching:
  - Verb/intent contains `teach`, `learn`, or `define`
  - Prompt includes `learn`, `remember`, or `teach`
- If a learning is added, short-circuit and return a confirmation message.

Reference function to copy:

- `isLearningIntent`

**7) Wire into email request flow**

- In the email endpoint that handles user requests, add:
  1. `refreshLearnings()`
  2. `learnings_sql` check using `qwen2.5-coder:14b`
  3. If `list` -> return human-readable rows
  4. If `delete` -> execute and confirm
  5. If `none` -> proceed to normal email intent handling
  6. If teaching intent -> `learnings_extract`, insert, return confirmation

**8) Environment variables**

- Keep these in `.env` (same names as home-assistant):
  - `ASSISTANT_URL`
  - `ASSISTANT_AUTH`
  - `ASSISTANT_MODEL` (default `qwen2.5:14b`)

**9) Docker**

- If this service is containerized, install SQLite and copy `learnings.db`:
  - `apk add --no-cache sqlite`
  - `COPY learnings.db ./learnings.db`
  - `COPY prompts ./prompts`

**10) Reference files**

- `E:\Source\LLMS\mss-homeassistant\src\homeAssistant.ts`
- `E:\Source\LLMS\mss-homeassistant\prompts\learnings_extract.json`
- `E:\Source\LLMS\mss-homeassistant\prompts\learnings_sql.json`

This guide should be followed exactly to keep behavior consistent between
services.

You may copy the .env file from the mss-homeassistant folder or update yours with what you may need from there.

You should add a endpoint querry that will contain the prompt from the orchestrator , which you must then use to ask the llm to convert it to a sqllite querry with your current sqllite schema so you can reply with the results
