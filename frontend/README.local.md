# Local development

This is the daily loop — run the frontend against the real Development API, on your
own machine, without waiting on a deploy:

```
npm ci
# .env.local
VITE_API_BASE_URL=https://api-development-154e.up.railway.app
npm run dev
```

## What the preview URL is for

The `Frontend - preview` Railway service (branch `feature/bulk-classes`) is for
**showing work**, not developing against. It is a static bundle rebuilt from
whatever is on that branch — point someone at it to look at something, don't point
your own editor's dev loop at it.

## How code reaches Development

Only by merging to `main` through CI. `main` is protected — direct pushes are
refused, merge requests need maintainer approval — and the Development services
wait for the GitHub Actions check suite before deploying. There is no path from a
feature branch straight to Development that skips that gate.
