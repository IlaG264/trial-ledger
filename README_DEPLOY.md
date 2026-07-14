# Deploy to Render

Use Render → New → Web Service.

Settings:

- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variables:
  - `ANTHROPIC_API_KEY` = your new Anthropic API key
  - `ANTHROPIC_MODEL` = `claude-sonnet-5`
  - optional: `NCBI_EMAIL` = your email
  - optional: `NCBI_API_KEY` = your NCBI API key

Do not commit `.env` or API keys to GitHub.

This app uses ClinicalTrials.gov, PubMed/NCBI E-utilities, and Europe PMC open-access endpoints. It does not bypass article paywalls.
