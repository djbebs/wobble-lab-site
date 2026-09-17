# Wobble Lab

Static site. No build step, no dependencies to install. Every file here is served as-is.

```
/                       home
/jelly/                 the live simulation + what it models
/experiments/           index of experiments
/science/               four articles on gel physics
/about/ /privacy/ /cookies/ /contact/
/404.html
/robots.txt /sitemap.xml /_headers

/assets/site.css        all styling
/assets/jelly.js        the jelly page module
/assets/softbody.js     the solver (no dependencies, reusable)
/assets/ads.js          shared advertising loader
/assets/vendor/         Three.js r181.1 (three.webgpu.js + three.core.js +
                        three.tsl.js - the first imports the others)
/assets/fonts/          Instrument Serif, self-hosted
```

## Run it locally

```
npx serve site
```

Opening the files directly with `file://` will not work: browsers block relative
module imports from that origin.

## Deploy to Cloudflare Pages

1. Push this folder to a GitHub repository.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → connect the repo.
3. Build command: leave empty. Output directory: `/` (or the folder containing `index.html`).
4. Deploy. You get a `*.pages.dev` URL with HTTPS immediately, at no cost.
5. Check it on a real phone before buying anything.
6. Only then add a custom domain, and set `ORIGIN` below.

## Before going live: search and replace

| Placeholder | Where | Replace with |
|---|---|---|
| `https://wobblelab.example` | `ORIGIN` in the build scripts, then rebuild | your real domain |
| `Wobble Lab` | `SITE` in the build scripts | your final name, once the domain and trademark are checked |
| `hello@your-domain.example` | `/contact/` | a working mailbox on your own domain |
| `ca-pub-0000000000000000` | `/assets/ads.js` | your AdSense publisher ID |
| `0000000000` | `/assets/ads.js` | your AdSense display unit ID |

While the AdSense identifiers are still placeholders, no ad request is ever sent.
The slot shows a reserved space so you can see the layout.

## Missing on purpose

- **`ads.txt`** — cannot be written until you have a publisher ID. One line, at the root.
- **Consent banner** — use Google's own certified CMP, switched on from the AdSense
  console. It loads with the ad tag. Do not hand-roll one.
- **`og.png`** — a 1200×630 social preview image is referenced but not created.
- **Analytics** — nothing installed. Cloudflare Web Analytics is cookieless and
  needs no banner; add it only if you will actually read it.

## Do not

- Turn on **Auto Ads**. It injects its own overlays and vignettes and would undo the
  guarantee that advertising never covers the simulation.
- Apply to AdSense before the content is genuinely in place. A rejection costs weeks.

## Adding an experiment

`softbody.js` takes a shape function and returns a deforming mesh:

```js
import { SoftBody, shapes } from "/assets/softbody.js";
const body = new SoftBody({ shape: shapes.sphere(1.15, 1.06), floorY: -1.35 });
body.step(dt);   // body.positions and body.indices are yours to render
```

A new experiment is a rest shape, a parameter set and a page. Copy `/jelly/` and
`/assets/jelly.js`, change the shape, add the route to `sitemap.xml` and a card to
`/experiments/`. Do not publish a page until the experiment behind it works; empty
placeholder pages are a documented cause of AdSense rejection.
