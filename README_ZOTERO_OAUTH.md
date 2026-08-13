# Clinical Trial Evidence Assistant — Per-User Zotero OAuth

This version replaces the single hard-coded Zotero account with a **Connect Zotero** flow.

Each person who uses the site can connect their own Zotero account. Zotero itself handles the login and consent screen.

## What changed

The app now has:

- `GET /auth/zotero/start` — starts Zotero OAuth
- `GET /auth/zotero/callback` — receives the user back from Zotero
- `GET /api/zotero/status` — tells the frontend whether this browser is connected
- `POST /auth/zotero/disconnect` — forgets the Zotero credential in this browser
- `GET /api/zotero/library` — loads the connected user's library
- `GET /api/zotero/article/:itemKey` — loads one article, notes, and indexed full text if available

The user's Zotero API key is stored in an **encrypted, HttpOnly cookie**. It is not exposed to frontend JavaScript and is not committed to GitHub.

## Important: one manual Zotero setup step is still required

Zotero requires the app owner to register the application and obtain a **Client Key** and **Client Secret**.

Open Zotero's application registration page while signed into the Zotero account that owns the app.

Use your Render callback URL:

`https://YOUR-RENDER-SERVICE.onrender.com/auth/zotero/callback`

After registration, Zotero gives you:

- `ZOTERO_CLIENT_KEY`
- `ZOTERO_CLIENT_SECRET`

Do not put the Client Secret in GitHub.

## Render Environment Variables

In Render:

**Dashboard → your Web Service → Environment → Edit**

Keep your existing:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `NCBI_EMAIL` (optional)
- `NCBI_API_KEY` (optional)

Add:

- `ZOTERO_CLIENT_KEY` = value Zotero gives you
- `ZOTERO_CLIENT_SECRET` = value Zotero gives you
- `APP_BASE_URL` = exact Render origin, e.g. `https://clinical-trial-evidence-assistant.onrender.com`
- `SESSION_SECRET` = a long random secret

Generate `SESSION_SECRET` locally with:

```bash
openssl rand -hex 32
```

You no longer need the old single-user:

- `ZOTERO_USER_ID`
- `ZOTERO_API_KEY`

They can be removed from Render after the OAuth version is deployed.

## Zotero permissions requested

The authorization page requests:

- personal library read access
- personal notes read access
- no write access
- no group-library access

## User flow

1. User clicks **Connect Zotero**.
2. Browser goes to Zotero.
3. User signs into Zotero and approves read-only access.
4. Zotero redirects to `/auth/zotero/callback`.
5. Backend exchanges the temporary OAuth token for that user's Zotero API key and user ID.
6. Backend encrypts those credentials into an HttpOnly cookie.
7. User can load and query only their own Zotero library.

## Security notes

- Never commit `.env`.
- Never place `ZOTERO_CLIENT_SECRET` in `public/index.html`.
- Never place an individual user's Zotero API key in frontend JavaScript.
- HTTPS should be used in production (Render provides HTTPS).
- This prototype remembers the Zotero connection in an encrypted browser cookie for 30 days.
- Clicking **Disconnect Zotero** clears the app's cookie. To fully revoke the generated Zotero API key, the user can also revoke it in their Zotero account settings.

## Local development

Create `.env` from `.env.example`.

For a local OAuth callback, the callback URL registered with Zotero must match your local callback URL, for example:

`http://localhost:3000/auth/zotero/callback`

Then run:

```bash
npm install
npm start
```

and open:

`http://localhost:3000`
