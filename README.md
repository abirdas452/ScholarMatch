# ScholarMatch — AI-assisted scholarship discovery

A full-stack hackathon project built with Node.js, Express, SQLite and an OpenAI-compatible API. It imports the 136 scholarship records from the supplied CSV and provides student matching, secure account flows, an admin workspace and AI-generated guidance when an API key is configured.

## Features
- Responsive, presentation-ready interface with profile-based scholarship matching.
- 136 CSV scholarship records seeded into SQLite on first run.
- Secure password hashing with bcrypt (12 rounds).
- Server-side sessions stored in SQLite; HttpOnly + SameSite cookies; session regeneration after login.
- Public signup always creates a `student`; admin role is provisioned only from server environment variables.
- Admin-only overview and scholarship create/edit/delete API permissions (the UI currently exposes add + overview; edit/delete endpoints are available for future admin UI).
- AI recommendation endpoint using the OpenAI API. If no API key is set, the app returns a transparent rule-based guidance preview rather than pretending AI is active.
- Login rate limiting, Helmet security headers, input validation and parameterized SQL queries.

## Run locally

1. Install Node.js 20 or newer.
2. In this folder run:

   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and update the values. Set a long random `SESSION_SECRET`, a strong `ADMIN_PASSWORD`, and your `OPENAI_API_KEY`.
4. Start the app:

   ```bash
   npm start
   ```
5. Open `http://localhost:3000`.

## Admin login
Use the `ADMIN_EMAIL` and `ADMIN_PASSWORD` values from `.env`. The admin account is created/updated at server startup. Do not use the example password in a real deployment. Never expose `.env` or commit it to source control.

## Enable AI
Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` (default: `gpt-4o-mini`) in `.env`, then restart the server. The key stays on the server and is never sent to the browser. The AI receives the student's submitted profile and a shortlist of scholarships that already pass the app's eligibility rules. It is instructed not to invent deadlines, awards or guarantees. Final criteria should always be confirmed with providers.

Without an API key, matching still works and the AI panel clearly labels its output as a smart-matching preview. This is not a live AI response.

## Database
SQLite database and session store are created in `data/` automatically. The scholarship seed runs only when the scholarship table is empty. To reset local demo data, stop the server and remove `data/scholarmatch.sqlite` and `data/sessions.sqlite`, then restart.

## Important before public launch
This is a hackathon-ready starter, not a completed security audit. For deployment: use HTTPS, set `NODE_ENV=production`, use a strong secret, configure secure cookies and reverse-proxy trust correctly, add CSRF protection/origin validation, email verification and password reset, audit admin actions, back up the database, and consider PostgreSQL for multi-instance scale. Add verified official application URLs before presenting direct application links. Never claim a student is guaranteed to receive a scholarship.
