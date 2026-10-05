# Waymark

Self-hosted business mileage log. Log journeys, get driving distances from Google, and export monthly claim CSVs.

- **Journeys:** multi-stop route builder; distances from the Google Routes API, cached so each pair of places is looked up only once.
- **Places and customers:** each leg is assigned to the destination's customer (or the origin's, when it ends at a home place).
- **Export:** export a CSV with totals and a summary by customer and user.
- **Maps (optional):** pick a place's location on a map; click a journey to see its route.
- **Users:** Administrator, User and Accounts (read-only) roles; optional two-factor sign-in and passkeys.
- **Activity log:** permanent, append-only record of every change, export and sign-in.

Node.js + Express + SQLite (one file, `data/waymark.db`). No build step.

## Setup

Needs **Node.js 22.13+**

```bash
npm install
cp .env.example .env
npm start
```

Set these in `.env`:

| Setting | |
|---|---|
| `SESSION_SECRET` | Long random string: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it signs everyone out and makes the saved Google key unreadable. |
| `APP_URL` | The address people use, e.g. `http://localhost:3000`. Passkeys only work here. |
| `HOST`, `PORT` | `0.0.0.0` to allow other devices on the network, `127.0.0.1` for this PC only. |
| `TRUSTED_ORIGINS` | Any other addresses people sign in from, e.g. `http://192.168.1.20:3000`. |

Then open the app. On a new install there are no accounts, so the first person to open it creates the administrator (username, email, password) and is offered two-factor sign-in. Do this straight away, unless you like danger...

## Google keys

Create both in one Google Cloud project (billing on; normal use stays within the free allowance). Add them in **Settings**.

| Key | Enable | Restrict to | Used for |
|---|---|---|---|
| **Server key** | Routes API | Your server's IP | Distances and routes. Stored encrypted; never sent to browsers. |
| **Browser key** (optional) | Maps JavaScript API, Geocoding API | Websites: each app address + `/*` | The map picker and route map. |

They must be separate keys: the browser key is visible to signed-in users, and Google allows only one kind of restriction per key.

## Rules worth knowing

- **Claim** = miles × rate, rounded to 2 dp per leg. The rate is the user's own, or the company default.
- **Duplicates:** a leg with the same date, start, destination and ticket ID as one the same person has already logged is refused.
- **Test entries** are excluded from exports and can be deleted freely.
- **Renaming a place** keeps its cached distances; **moving** it clears them so they're looked up again. Past entries keep the name they were logged with.
- **Deleting a user** is only allowed if they have no journeys; otherwise deactivate them.

## Backups

- A backup is saved automatically each year on or after 6 April, to `backups/`.
- Back up any time with `npm run backup`, or from **Settings**.
- Copy `backups/` somewhere off this machine.
- To restore: stop the app, replace `data/waymark.db` with a backup, start it again.