# DataFlow Systems - Multi-Tool AI Pipeline (Vercel + Gemini)

## Quick answers to your questions

**How do I test APIs individually before integrating them? Why is testing in isolation important?**
- Test each API with a tiny script or curl first to validate auth, payload shape, and error codes.
- Isolation makes debugging faster: you can pinpoint if a failure is caused by that service or your orchestration code.
- It helps you set realistic retries/timeouts and capture rate-limit behaviors early.

**What is error handling and why do I need it in API integrations? What happens without it?**
- Error handling is catching and responding to failures (timeouts, 4xx/5xx, invalid JSON) gracefully.
- Without it, one failing call can crash the whole pipeline, lose partial progress, and hide root causes.
- Good error handling lets you continue processing remaining items and return helpful error details.

**In the AI era, can AI handle all API integration or do I need to understand HTTP basics? What breaks without understanding?**
- You still need HTTP basics: methods, status codes, headers, timeouts, and rate limits.
- Without that, integrations fail silently (wrong method, bad headers, 401/429 handling, malformed JSON) and are hard to debug.
- AI helps speed you up, but it cannot replace understanding the contracts you are integrating.

## What this repo does

This project provides a Vercel serverless endpoint that:
- Fetches JSONPlaceholder comments (first 3 items)
- Enriches each item via Gemini (summary + sentiment)
- Stores results in a local JSON file (or `/tmp` on Vercel)
- Sends a notification (console log) to the requested email
- Returns a structured JSON response with errors per stage

## Endpoint

`POST /api/pipeline`

Request body:

```json
{
	"email": "notification-email@example.com",
	"source": "JSONPlaceholder Comments"
}
```

Response shape:

```json
{
	"items": [
		{
			"original": "Original text/data from source",
			"analysis": "AI-generated analysis (2-3 sentences)",
			"sentiment": "positive/negative/neutral",
			"stored": true,
			"timestamp": "2026-01-28T10:30:00Z"
		}
	],
	"notificationSent": true,
	"processedAt": "2026-01-28T10:30:05Z",
	"errors": []
}
```

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Create a local env file:

```bash
cp .env.example .env
```

3. Add your Gemini API key to `.env`:

```
GEMINI_API_KEY=your_api_key_here
```

4. Run locally (Vercel dev):

```bash
npx vercel dev
```

Example request:

```bash
curl -X POST http://localhost:3000/api/pipeline \
	-H "Content-Type: application/json" \
	-d '{"email":"23f2003858@ds.study.iitm.ac.in","source":"JSONPlaceholder Comments"}'
```

## Deployment (Vercel free)

- Import this repo into Vercel.
- Set `GEMINI_API_KEY` in Project Settings -> Environment Variables.
- Deploy; your endpoint will be at `https://<your-app>.vercel.app/api/pipeline`.

## Storage details

- Local: `data/results.json`
- Vercel: `/tmp/results.json` (ephemeral)

## Notes

- The pipeline continues processing items even if one fails.
- Errors are returned in the `errors` array with stage context.
- Notification is a console log to the requested email.