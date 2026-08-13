# Zotero-enabled Clinical Trial Evidence Assistant

This version adds a private Zotero-library integration to the existing Clinical Trial Evidence Assistant.

## Important security rule

Do **not** paste your Zotero API key into `server.js`, `index.html`, GitHub, or this README.

The backend reads the key from an environment variable:

- `ZOTERO_USER_ID=21263291`
- `ZOTERO_API_KEY=<your private read-only Zotero key>`

For Render, add those under your Web Service's **Environment** settings.

For local testing, copy `.env.example` to `.env` and put the real key only in `.env`.
`.env` is ignored by Git.

## Existing environment variables

Keep your existing values for:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `NCBI_EMAIL` (optional)
- `NCBI_API_KEY` (optional)

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## New Zotero features

- Load up to 100 recent top-level Zotero items.
- Filter by title, author, DOI, or tag.
- Select one Zotero article.
- Retrieve Zotero metadata, abstract, child notes, and indexed attachment full text when available.
- Ask the chatbot questions about only the Zotero article.
- Use a Zotero article alongside a selected ClinicalTrials.gov trial.
- Use the Zotero article as an extra evidence source while comparing two trials.

## Deployment

Push this entire folder to GitHub, but never commit `.env`.

On Render, add `ZOTERO_USER_ID` and `ZOTERO_API_KEY` as environment variables, then redeploy.
