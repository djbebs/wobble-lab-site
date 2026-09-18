# Wobble Lab

Static site. No build step, no dependencies to install.

## Layout

```
wrangler.jsonc          Cloudflare config. Points at public/.
README.md               this file
public/                 EVERYTHING that gets published, and nothing else
  index.html            home
  jelly/                the live simulation + what it models
  science/              four articles on gel physics
  experiments/          index of experiments
  about/ privacy/ cookies/ contact/
  404.html  robots.txt  sitemap.xml  _headers
  assets/site.css       all styling
  assets/jelly.js       the jelly page module
  assets/softbody.js    the solver (no dependencies, reusable)
  assets/ads.js         shared advertising loader
  assets/vendor/        Three.js r181.1 (three.webgpu.js + three.core.js +
                        three.tsl.js - the first imports the others)
  assets/fonts/         Instrument Serif, self-hosted
```

**Why the public/ folder.** A first deploy served the repository root, and
`.git/objects/...` was published along with the site. An `.assetsignore` file is
supposed to prevent that and did not work reliably. Serving a subfolder makes
the problem structurally impossible: `.git`, this README and the config sit
outside `public/` and cannot be reached.

Never move a file out of `public/` expecting it to still be served, and never
put anything private inside it.

## Run it locally

```
python -m http.server 8000 --directory public
```

Then open `http://localhost:8000`.

Do not open `index.html` directly. Browsers block relative module imports from
`file://` and the simulation will not start.

## Deploy

```
npx wrangler login      # once
npx wrangler deploy
```

`name` in `wrangler.jsonc` must match the Worker name in the Cloudflare
dashboard, or you deploy to a different Worker.

## Before going live: search and replace

| Placeholder | Where | Replace with |
|---|---|---|
| `https://wobblelab.example` | `ORIGIN` in the build scripts, then rebuild | your real domain |
| `Wobble Lab` | `SITE` in the build scripts | your final name, once domain and trademark are checked |
| `hello@your-domain.example` | `public/contact/` | a working mailbox on your own domain |
| `ca-pub-0000000000000000` | `public/assets/ads.js` | your AdSense publisher ID |
| `0000000000` | `public/assets/ads.js` | your AdSense display unit ID |

While the AdSense identifiers are placeholders, no ad request is ever sent. The
slot shows a reserved space so you can see the layout.

## Missing on purpose

- **`ads.txt`** cannot be written until you have a publisher ID. One line, in `public/`.
- **Consent banner**: use Google's own certified CMP, switched on from the
  AdSense console. It loads with the ad tag. Do not hand-roll one.
- **`og.png`**: a 1200x630 social preview image is referenced but not created.
- **Analytics**: nothing installed. Cloudflare Web Analytics is cookieless and
  needs no banner.

## Do not

- Turn on **Auto Ads**. It injects overlays and vignettes and would undo the
  guarantee that advertising never covers the simulation.
- Apply to AdSense before the content is genuinely in place. A rejection costs weeks.

## Adding an experiment

`softbody.js` takes a shape function and returns a deforming mesh:

```js
import { SoftBody, shapes } from "/assets/softbody.js";
const body = new SoftBody({ shape: shapes.sphere(1.15, 1.06), floorY: -1.35 });
body.step(dt);   // body.positions and body.indices are yours to render
```

A new experiment is a rest shape, a parameter set and a page. Copy `public/jelly/`
and `public/assets/jelly.js`, change the shape, add the route to `sitemap.xml` and
a card to `public/experiments/`. Do not publish a page until the experiment behind
it works; empty placeholder pages are a documented cause of AdSense rejection.
