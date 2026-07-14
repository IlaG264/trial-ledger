# Clinical Trial Evidence Assistant

This version searches ClinicalTrials.gov, loads a selected trial record, searches PubMed, and tries to retrieve legal open-access full text through Europe PMC.

It does not bypass paywalls. If no legal open-access full text is found, it uses PubMed/Europe PMC abstracts and the ClinicalTrials.gov record.

## Run locally

```bash
npm install
cp .env.example .env
open -e .env
npm start
```

Open:

```text
http://localhost:3000
```

## What changed

- Keyword search now retrieves many matching ClinicalTrials.gov trials instead of only 10.
- After selecting a trial, the app searches PubMed and Europe PMC.
- If a legal open-access article is available, the app adds a full-text snippet to the chatbot context.
- The chatbot is instructed to separate ClinicalTrials.gov evidence from article evidence.
