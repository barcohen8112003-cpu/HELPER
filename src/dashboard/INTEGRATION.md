# Dashboard

A read-only view of Helper's own data at `/dash` on the settings site: habits and streaks, expenses with a per-category chart, notes, shopping and other lists, goals and OKRs, exams and countdowns, and the catalogue of every toolkit tool.

## Files

| File | Role |
|---|---|
| `api.js` | `handleDashboard(req, res, url, signedIn)`. Serves the page and the JSON endpoints under `/dash/api/*`. Returns `false` for anything outside `/dash` |
| `dashboard.html` | The page: one file, vanilla JS and CSS, RTL Hebrew, works at phone width |
| `_selftest.js` | Offline tests (views, HTTP handling, auth, and HTML-injection attempts through a fake DOM) |

## How it is mounted

Already wired into `src/ui.js`, right after the sign-in check, with these two lines:

```js
import { handleDashboard } from './dashboard/api.js'
// ...
if (await handleDashboard(req, res, url, signedIn)) return
```

Nothing else in `ui.js` depends on it. Removing those two lines removes the dashboard.

## Why it is safe

- **Same sign-in as the settings site.** `/dash` answers 403 unless the `signedIn` function passed in returns true. Called without it, it fails closed.
- **Behind the host check.** The settings site's allowed-hosts rule applies before it is reached.
- **Read only.** GET and HEAD only (anything else gets 405). It never writes to `state`, calls a model or touches the network.
- **No HTML from data.** Every value is inserted as text through DOM nodes, never through `innerHTML`.
- **Strict headers.** A CSP with `default-src 'none'` and same-origin fetch only, `X-Frame-Options: DENY`, and `Cache-Control: no-store`.

## Data it reads

`state.toolkit` buckets written by the toolkit modules: `life_habits`, `life_expenses`, `life_notes`, `life_shopping`, `life_lists`, `life_goals`, `plan_okr`, `study_exams`, `plan_countdowns`. The tool catalogue comes from `src/toolkit/registry.js`. A bucket that does not exist yet just shows as empty.

## Test

```
node src/dashboard/_selftest.js
```
