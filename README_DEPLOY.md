# Deploy Trial Ledger to Render

This is the public-website version of the app. It is a Node/Express app with a static frontend in `public/` and a backend route at `/api/chat`.

## Important security step

Do not commit a real `.env` file or API key to GitHub. Put the key in Render's Environment Variables only.

## Render settings

- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `ANTHROPIC_API_KEY` = your new Anthropic API key
  - `ANTHROPIC_MODEL` = `claude-sonnet-5`

Render will also set `PORT` automatically.
