# Trial Ledger — Fixed version

This fixes the browser `Failed to fetch` issue by moving the Claude/Anthropic API call into a small Node/Express backend.

## Run it

1. Install Node.js 18 or newer.
2. Open this folder in Terminal.
3. Install packages:

```bash
npm install
```

4. Create your real `.env` file:

```bash
cp .env.example .env
```

5. Open `.env` and replace `sk-ant-api03-your-key-here` with your real Anthropic API key.

6. Start the app:

```bash
npm start
```

7. Open:

```text
http://localhost:3000
```

Do not open `public/index.html` directly by double-clicking it. The page must be served by the backend so `/api/chat` exists.
