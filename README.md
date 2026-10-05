# Waymark

A self-hosted web app for logging business mileage.

- **Mileage:** a spreadsheet-style table of every journey leg, with filters (year, month, business, Live/Test, search), sortable columns, running totals, and an **Add journey** route builder.
- **Places:** a table of saved destinations, with **Add place** and click-to-edit. You can paste Google Maps coordinates straight in.
- **Export:** claim CSV for any month or date range (`Mileage_YYYY-MM.csv`, Live rows only), with a TOTAL row and a summary underneath: period, legs, total miles and claim, and breakdowns by customer (and by user for all-users exports).
- **Activity:** a permanent log of who did what and when (journeys saved and deleted, exports, changes, sign-ins).
- **Settings:** default rate and home places, plus database backups.

The server is Node.js with SQLite: a single file, `data/mileage.db`. Google is used **only** to look up driving distances (Routes API), and only for pairs of places not already in the distance cache. Once a pair has been looked up, it is never looked up again.

```
waymark/
├── server.js              web server, login, JSON API
├── lib/                   auth.js · users.js · db.js · mileage.js (routes + Google) · customers.js · exporter.js (CSV, backups, scheduler) · audit.js (activity log) · googleKey.js · util.js
├── public/                index.html · app.js · styles.css · login.html · login.js · webauthn.js · theme.js
├── scripts/               backup.js
├── test/                  npm test
├── .env.example           copy to .env
└── data/  backups/        created at runtime (not in git)
```

---

## 1. Requirements

- **Node.js 22.13 or newer** (`node -v`). The app uses Node's built-in SQLite, so nothing needs compiling.
- A **Google Cloud API key** with the **Routes API** enabled. See step 3.
- Somewhere to run it: your PC, a home server or NAS, or a small VPS.

> **Don't run it from the OneDrive folder.** OneDrive syncing a live database file can corrupt it. Copy the project to a normal folder (e.g. `C:\Apps\waymark` or `/opt/waymark`) before running it for real. Use the `backups/` folder to keep copies safe instead.

## 2. Install

```bash
cd /path/to/waymark
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

Edit `.env` and set at least:

| Setting | What to put |
|---|---|
| `APP_PASSWORD` | The password for the first administrator account (**admin**, or `ADMIN_USERNAME` if set), created on first start. After that, passwords are managed in the app. |
| `SESSION_SECRET` | A random string. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. It signs sign-in sessions and encrypts the saved Google key. |
| `APP_URL` | The exact address people open the site at, e.g. `http://localhost:3000` or `https://mileage.example.com`. Passkeys only work at this address. If it starts with `https://`, cookies are marked Secure. |
| `GOOGLE_MAPS_API_KEY` | From step 3 |

## 3. Google API key (distances only)

1. Go to <https://console.cloud.google.com/>. Create a project, e.g. "Waymark". Billing must be enabled, but the Routes API has a monthly free allowance, and cached pairs are never looked up twice, so you will normally pay nothing.
2. Go to **APIs & Services → Library**, find **Routes API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → API key**.
4. Restrict the key:
   - **API restrictions:** allow the Routes API only.
   - **Application restrictions:** IP addresses, set to your server's public IP if it has a fixed one.
5. In the app, go to **Settings → Google Maps API key**, paste the key, click **Save key**, then click **Test key**.

How the key is kept safe:
- It is **write-only**. You can replace or remove it, but the app never displays it.
- It is stored encrypted in the database, using `SESSION_SECRET`. If you change `SESSION_SECRET`, you'll need to enter the key again.
- It is only ever used on the server.

(Alternatively, put it in `.env` as `GOOGLE_MAPS_API_KEY=`. A key saved in Settings takes priority.)

### Optional: maps (a second, browser key)

With this set up, you get two maps:
- **Pick on map** in the place form. It opens a Google map where you can search an address or postcode, click to drop a pin, and drag it to adjust. **Use this location** fills in Lat/Lng, and the address too if it's empty.
- **Route map** on the Mileage page. Click any entry to see the driving route from its start to its destination, with the logged miles and claim next to today's route distance and drive time. If the two differ noticeably, it says so. The route is worked out on the server with the server key (Routes API) the first time an entry is viewed, then stored, so viewing it again costs nothing. If a place's coordinates change, its routes are worked out again.

The map runs in the browser, so it needs its **own** key. Don't reuse the server key above: this one is sent to signed-in browsers.

1. In the same Google Cloud project, go to **APIs & Services → Library** and enable the **Maps JavaScript API** and the **Geocoding API**.
2. Go to **Credentials → Create credentials → API key**, and restrict it:
   - **API restrictions:** Maps JavaScript API and Geocoding API only.
   - **Application restrictions:** Websites. Add every address you open the app at, each followed by `/*`, for example `http://localhost:3000/*` and `http://192.168.1.20:3000/*`. Settings shows the address you're using now.
3. In the app, go to **Settings → Map picker key**, paste it and click **Save key**. (Or put it in `.env` as `GOOGLE_MAPS_BROWSER_KEY=`.)

The maps run on their own pages (`map-picker.html`, `route-map.html`), which are the only pages allowed to load Google's scripts. The rest of the app keeps its strict security policy. Each time the map opens, it counts as one map load against Google's monthly free allowance.

## 4. Your data

Everything you enter (places, customers, journeys, users, the distance cache) lives in one SQLite file, `data/mileage.db` by default. It is created empty on first start and is never part of the code, so the same code can run against any database.

To use an existing database, copy its `.db` file (or one from `backups/`) into place, or point `DB_FILE` at it.

## 5. Run it

```bash
npm start
```

Open <http://localhost:3000> and sign in as **admin** with `APP_PASSWORD`.

### Keep it running

| Host | How |
|---|---|
| **Windows PC/server** | Use [NSSM](https://nssm.cc/): `nssm install Waymark "C:\Program Files\nodejs\npm.cmd" start`, set the startup directory to the app folder, then `nssm start Waymark`. |
| **Linux / VPS / Raspberry Pi** | Use a systemd unit with `WorkingDirectory=/opt/waymark`, `ExecStart=/usr/bin/npm start` and `Restart=always`. |
| **Any (simple)** | `npm i -g pm2 && pm2 start npm --name waymark -- start && pm2 save && pm2 startup` |

### Using it from your phone (HTTPS)

Don't expose plain `http://` to the internet. Pick one option:

- **Tailscale (easiest, private):** install Tailscale on the server and your phone. Open `http://<server-name>:3000` from the phone. Nothing is exposed publicly.
- **Cloudflare Tunnel:** run `cloudflared tunnel` to give the site a public HTTPS URL on your own domain, with no ports opened. Set `HOST=127.0.0.1` and `COOKIE_SECURE=true`.
- **Reverse proxy** (Caddy, nginx or IIS) with a certificate in front of port 3000. Again set `HOST=127.0.0.1` and `COOKIE_SECURE=true`.

On the phone, use **Add to Home Screen** so the site opens like an app.

## 6. Users and roles

Everyone signs in with their own username and password.

| Role | Can do |
|---|---|
| **Administrator** | Everything: log journeys, see and delete everyone's entries, export for anyone, manage customers, places, settings and users. |
| **User** (engineer) | Log their own journeys, and see, delete and export only their own. Can add and edit places. |
| **Accounts** | Read-only. Sees every user's journeys, filters by user, and exports one user or all users. Can't add, change or delete anything. |

**Adding someone** (for example Helen in Accounts):
1. Go to **Users → Add user**.
2. Enter their name and a username (e.g. `helen`), and pick the role.
3. Keep the generated temporary password and give it to them. They'll be asked to change it after signing in.

**Editing someone:** click them in the Users list to change their role, set their home place and rate, reset their password, or deactivate them.
- Deactivating or resetting a password signs them out on every device.
- You can't remove your own admin access, and there must always be at least one administrator.

**Settings → My account** (everyone):
- Your name.
- Your **home place**, used by "Round trip Home". A leg ending there takes the customer of where it started.
- Your **rate**. Leave it blank to use the company default.
- Your password.

**Exports:**
- Users always get only their own journeys, in a file named like `Mileage_2026-09_bob.csv`.
- Administrators and Accounts pick a user, or **All users**. An all-users export (`Mileage_2026-09_all-users.csv`) starts with a **User** column and shows a per-user breakdown.

**Duplicate check:** this is per person, so two engineers can log the same trip on the same day.

### Sign-in security (Better Auth)

Sign-in uses [Better Auth](https://www.better-auth.com). Everyone signs in with a username and password. Each person can also add either or both of these in **Settings → Sign-in security**. Both are optional:

- **Two-factor sign-in.** After your password, you also enter a 6-digit code from an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and so on).
  - To set it up: click **Turn on**, enter your password, scan the QR code, then enter the code the app shows.
  - Save the 10 **backup codes**. Each one works once if you lose your phone. You can make new ones at any time.
  - At sign-in you can tick "Don't ask again on this device for 30 days".
- **Passkeys.** Sign in with your fingerprint, face or device PIN instead of a password. Add one on each device you use.
  - Passkeys only work when the site is opened at its `APP_URL`, over HTTPS (or `localhost` on the server PC).

**Lost phone and backup codes:** an administrator opens the user in **Users**, ticks "Turn off their two-factor sign-in" and saves. The user is signed out and can sign in again with just their password.

**How it's protected:**
- **Passwords:** stored as scrypt hashes, never in plain text.
- **Sessions:** kept in the database. Changing a password, resetting one, or deactivating a user signs that person out on every device.
- **Locking out guessing:** 5 failed sign-ins or codes from one address lock it out for 15 minutes.
- **No self-registration:** only administrators can create accounts.
- **Admin actions:** these go through the app's own checks, which is why there's always at least one active administrator.
- **Requests from other sites:** sign-in requests have to come from the app's own pages, so another website can't sign someone in or act for them.

## 7. Using the app

**Mileage → Add journey**
1. Pick the date and choose stops. Type a few letters to search places.
2. Use **▲▼** to reorder stops and **✕** to remove one. The shortcuts **Return to start** and **Round trip Home** fill in common routes.
3. Click **Preview**. Each leg shows its miles, whether the distance came from the cache or Google, its business and its claim.
4. Click **Save**. This writes one log row per leg. Legs from a place to itself are skipped.
5. A leg with the same Date + Start + Destination + Ticket ID as an existing row is **blocked**, and nothing is saved.

Other rules:
- **Business per leg:** the override if you set one. Otherwise the destination's default business, except when the destination is a home place (Settings), in which case the business of where the leg started.
- **Claim:** miles × rate, rounded to 2 dp per leg.
- **Missing coordinates:** a leg whose distance isn't cached needs coordinates for both places, and the app names any that are missing.

**Places.** Click **Add place**, or click a row to edit it. In Google Maps, right-click the pin (or long-press it on a phone), copy the `54.83, -3.16` line, and paste it into "Paste coordinates". Lat and Lng fill in automatically.
- Renaming a place also renames it in the distance cache.
- Moving its coordinates clears that place's cached distances, so they get re-fetched.

**Customers.** Each site belongs to a customer. On the **Customers** page you can:
- **Add** a customer.
- **Rename** one. The new name appears everywhere straight away, including past journeys and exports.
- **Tick its sites.** Moving a site to another customer only affects future journeys.
- **Merge** two customers. This moves all of one customer's sites and past journeys into the other, which is how you tidy up duplicates.
- **Delete** a customer, but only if it has no journeys.

Each journey leg takes its customer from the destination site. If the destination is a home place (e.g. Home), it takes the customer of the site it started from instead. You can override this on any trip with **Customer override**.

**Test entries.** Set Data type to **Test** while trying things out. Test rows never appear in exports, and you can delete them from the Mileage table with the bin icon.

## 8. Backups (HMRC: keep records for 6 years)

- **Automatic:** once a year, on or after **6 April**, the server writes `backups/mileage-<timestamp>.db` and a full-log CSV.
- **Any time:**
  - On the server: Settings → **Save backup on server now**, or `npm run backup`.
  - To your own device: Settings → **Download database backup (.db)**.
- Copy the `backups/` folder somewhere off the server, such as OneDrive or a USB drive. Keep at least 6 tax years.
- **To restore:** stop the app, replace `data/mileage.db` with a backup `.db`, then start the app again.

## 9. Activity log

Every action is recorded in the **Activity** page (Administrators and Accounts). Each entry shows when it happened, who did it, what they did and the IP address it came from:

- **Journeys:** saved (route, miles, claim, entry IDs) and deleted. A deleted entry's details are kept in the log, so it can still be traced.
- **Exports:** every CSV download, with its period, who it covers and its totals.
- **Changes:** places, customers, users and settings, with what changed from what to what.
- **Backups:** saved on the server, downloaded, and the automatic yearly backup.
- **Sign-ins:** successful and failed sign-ins (with the username tried), lock-outs, sign-outs, password changes, two-factor and passkey changes.

The log is append-only: the app has no way to edit or delete it, and the database itself refuses changes to it. It's stored in the same database file, so it's included in every backup.

## 10. Testing

```bash
npm test
```

This runs the logic tests against a temporary database and makes no Google calls. It covers:
- claim rounding and the customer rule
- the duplicate block and the missing-coordinates error
- that Test rows are excluded from exports, and the CSV format
- cache renaming when a place is renamed or moved
- customers (rename, merge, delete rules), users and roles, and sign-in security
- the activity log (what gets recorded, who can see it, and that it can't be changed)
- backups

To try it by hand:
1. Run `npm start` and add a journey with **Data type = Test**.
2. Check that a leg you've logged before shows **CACHE**.
3. Check that a new pair between two places that have coordinates shows **GOOGLE**, and **CACHE** the next time.
4. Delete the Test rows afterwards.

## 11. Updating

1. Stop the app.
2. Back up first: `npm run backup`.
3. Replace the code files (never `data/` or `.env`).
4. Run `npm install`.
5. Start the app again.
