# Learning Integration Guide

This file contains the learning-related requirements extracted from `LLM.md`.

**1) Learning storage**

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

**2) Learning detection + SQL tool**

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

**3) Learnings injection (only when relevant)**

- Include learnings in prompts only when a learning shares a non-stopword
  token with the request payload.
- Reuse the stopword filter and matcher from
  `mss-homeassistant/src/homeAssistant.ts`:
  - `STOP_WORDS`
  - `tokenizeText`
  - `learningTokensMatchPrompt`

**4) Learning intent**

- Only attempt learning extraction if the user is teaching:
  - Verb/intent contains `teach`, `learn`, or `define`
  - Prompt includes `learn`, `remember`, or `teach`
- If a learning is added, short-circuit and return a confirmation message.

Reference function to copy:

- `isLearningIntent`
