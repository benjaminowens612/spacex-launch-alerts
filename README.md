# LaunchView

LaunchView is an iPhone-first web app and auto-updating calendar feeds so you never miss a SpaceX launch.

- **Calendar alerts:** subscribe once on your iPhone. Every launch with a set time appears in Calendar with alerts at **T-1 hour** and **T-10 minutes**. When a launch is scrubbed or delayed, the existing event moves instead of a duplicate appearing.
- **Filters:** pick a feed. Options are every launch, no Starlink, notable only (Starship, crewed and Falcon Heavy), or single-category feeds.
- **Web app:** live T-minus countdown, launch status, weather, a link to the webcast, and a one-tap button to add a single launch to your calendar. You can add it to your Home Screen.

**Site:** https://benjaminowens612.github.io/spacex-launch-alerts/

## How it works

```
GitHub Action (every 15 min)
  └─ scripts/build.mjs ── Launch Library 2 API (The Space Devs)
       ├─ docs/data/launches.json   → web app
       └─ docs/cal/*.ics            → calendar subscriptions
  └─ deploys docs/ to GitHub Pages; commits the data when launches change
```

| Feed | What's in it |
|---|---|
| `cal/all.ics` | Every SpaceX launch |
| `cal/no-starlink.ics` | Everything except routine Starlink missions |
| `cal/notable.ics` | Starship, crewed and Falcon Heavy |
| `cal/starship.ics`, `cal/crewed.ics`, `cal/starlink.ics` | One category each |

How each launch appears in a calendar depends on how precisely its time is known:
- **Known to the hour or better:** a timed event with alerts.
- **Known to the day:** an all-day event with no alerts.
- **Only known to the week or month** ("NET December"): left out of the calendars, but still shown in the app.

Completed launches stay in the feeds for 7 days, marked ✅ or ❌.

## iPhone setup

1. Open the site in Safari and go to **Get alerts**. Tap **Subscribe** next to a calendar.
2. In the iOS dialog, turn **Remove Alerts** off. If you leave it on, the events arrive without alerts.
3. Go to Settings › Apps › Calendar › Calendar Accounts › **Fetch New Data**, and set Fetch to **Every 15 Minutes**.
4. Go to Settings › Notifications › Calendar and turn on **Allow Notifications** and **Time Sensitive**.
5. Optional: in Safari, tap Share › **Add to Home Screen** to use the app full-screen.

> iOS refreshes subscribed calendars on its own schedule. A scrub announced in the last few minutes may reach your calendar late, so check the app for live status.

## One-time GitHub setup

- **Settings › Pages › Build and deployment › Source:** choose **GitHub Actions**.
- **Actions** tab: if the first run failed because Pages wasn't enabled yet, open **Update launches** and choose **Run workflow**.

GitHub disables scheduled workflows after 60 days without repository activity. The data commits normally keep this repo active. If the schedule ever stops, re-enable it from the Actions tab.

## Development

```sh
npm test                 # unit tests (ICS format, categories, feeds)
npm run build            # fetch live data from Launch Library 2
npm run build:fixture    # offline sample data for previewing the UI
npm run serve            # http://localhost:8080
```

No dependencies. Needs Node 20 or later.

Data comes from [Launch Library 2](https://thespacedevs.com/llapi) by The Space Devs. This project is not affiliated with SpaceX.
