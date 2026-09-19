# jesselliot.com

Portfolio site for Jess Elliot — stage design, scenic painting and immersive
environments. Astro, static output, deployed to Cloudflare Workers.

## Getting it running

Requires Python 3 with Pillow (`pip3 install --user Pillow`) for the image
pipeline, and Node for the site itself.

```bash
pnpm install
npm run assets     # derive web images from the masters (see below) — do this first
npm run dev
```

`npm run assets` (Python + Pillow) reads Jess's masters from `~/Desktop/Jess Website/JESS PORTFOLIO IMAGES`
and writes web-ready copies into `src/assets/projects/<slug>/`. Override the
source location with `JESS_SOURCE=/some/path npm run assets`. Nothing renders
until this has run at least once.

## How the images work

The masters are ~2.1GB with single files up to 41MB. They are **not** in the
repo and never should be. `scripts/build_assets.py` downsizes each to 2560px
on the longest edge at q80 mozjpeg (~600KB) and writes them with deterministic
names — `enigma-01.jpg`, `enigma-02.jpg` and so on, in sorted order.

Those derived files **are** committed, because Workers Builds builds from this
repo and has no access to Jess's disk. About 92MB total, which git handles
fine.

Each project folder also gets a `_manifest.json` recording the original
filename, dimensions and the photographer inferred from that filename
(`DIARYOFROSS_-44.jpg` → "Diary of Ross"). That is how per-image credit survives
the rename.

**Galleries are read from the folder, not from frontmatter.** To add a photo to
a project: drop it in the source folder, run `npm run assets`, commit. No
frontmatter edit. The `images:` map in a project's frontmatter only *overrides*
the derived defaults — alt text, a caption, a corrected credit, pinned order:

```yaml
cover: enigma-11.jpg        # the project page's full-screen hero
landing:                    # the pool the homepage tile rotates through
  - enigma-04.jpg
  - enigma-11.jpg
  - enigma-27.jpg
images:
  enigma-04.jpg:
    alt: The tree booth at dusk, lit from below
    caption: Booth façade, 2024 edition
    credit: Diary of Ross
    order: 1                # pin to the front of the gallery
```

`cover` and `landing` are the only two fields that select images by name, and
both are checked against `_manifest.json` at build time — a typo fails the
build rather than silently rendering the wrong photograph. There is no
"exclude" field: an image is on the landing strip because `landing` names it,
not because it failed to opt out.

### Why 2560px

Workers static assets cap a single file at 25 MiB, and a Worker version at
20,000 files on the free plan (100,000 on paid). Astro emits ~5 srcset variants
per image, so ~139 images is ~685 files — comfortably inside both. Feeding sharp
a 2560px master rather than a 41MB original is also what keeps the build inside
Workers Builds' 20-minute timeout; a full build currently takes about 45
seconds.

### Videos

The seven `.mov` files in the source folders (13–19MB each) are skipped. Astro
does not optimise video, and they would each eat most of the per-asset budget.
If they come back, convert to muted looping webm/mp4 first and add a `video`
field to the schema.

## Checking the layout

```bash
npm run build && npm run check
```

`scripts/check-layout.mjs` opens every built route in headless Chromium at
1440, 880 and 390 wide and asserts the document does not scroll sideways. It
names the offending element rather than just the page:

```
✗ tablet   /projects/enigma/ — 23px too wide
    figure.polaroid ends at 903px (viewport 880px)
```

Elements inside a scroll container of their own are ignored, so the landing
strip and Enigma's signs band — both of which are *meant* to move sideways —
do not register. Pass `--url http://localhost:4321` to check a running dev
server instead of the build.

It exists because the polaroid cluster shipped at 122% of its own column and
nothing caught it: the grid column was `minmax(0, …)` so the column held and
the content quietly dragged the document's scroll width out with it. There is
deliberately no `overflow-x: clip` anywhere in the stylesheets — that would
hide this symptom while leaving the component the wrong size.

## Content

- `src/content/projects/*.md` — one file per project. Sub-projects (Lamps)
  point at their parent with `parent:`, and are listed under it rather than
  beside it.
- `src/content/services/*.md` — one per tag. The taxonomy is a **closed set**
  defined in `src/content.config.ts`, so a tag outside the list fails the build
  rather than creating a dead end. There are no `/services/` routes and no nav
  dropdown: the collection survives only to validate tags and to keep their
  display titles in one place.

`draft: true` keeps a project out of every index and out of the sitemap while
still building its page, so it can be reviewed on a preview URL. Nothing is
drafted at the moment — The Nest and Lamps are published but still have no
photography in the source folders.

## Deploying to Cloudflare Workers

Configured in `wrangler.jsonc`. `npm run build` emits `dist`, which is uploaded
as the Worker's static assets. Everything stays inside the free tier.

The contact form is the only server-side code: `worker/enquiry.ts`, called from
`worker/index.ts`. A request matching a built file is served from assets without
invoking the Worker at all — only `POST /api/enquiry` and genuine 404s reach it.

`PUBLIC_TURNSTILE_SITE_KEY` is read through `import.meta.env` in
`src/pages/contact.astro`, so Astro inlines it at build time: it has to be set
as a **build** variable, not a runtime secret, or the widget ships with the
always-passes test key. The other three are runtime secrets — `wrangler secret
put <NAME>`, or the dashboard under the Worker's Settings → Variables and
Secrets. Locally, put all four in `.dev.vars` for `wrangler dev`:

| Variable | Where it comes from |
|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile widget, Cloudflare dashboard |
| `TURNSTILE_SECRET_KEY` | same widget |
| `RESEND_API_KEY` | resend.com — free tier is 3,000/month |
| `ENQUIRY_TO` | where enquiries land, e.g. `jess@jesselliot.com` |
| `ENQUIRY_FROM` | a verified sender on the domain |

Resend rather than MailChannels: MailChannels ended its free Cloudflare Workers
integration, so the old no-API-key route is gone.

### Bot prevention

Three layers, cheapest first, all re-checked server-side:

1. **Honeypot** — a field positioned off-screen. Bots fill everything.
2. **Elapsed time** — anything submitted in under 3 seconds was not typed.
3. **Turnstile** — free, no puzzles, no tracking.

The first two return a silent success rather than an error, so a bot never
learns why it failed.

### Why Python for the pipeline, not sharp

sharp ships a platform-specific native binary, so a `node_modules` installed on
macOS cannot run it on Linux and vice versa — the pipeline breaks the moment it
runs anywhere other than the machine that installed it. Pillow has no such
failure mode. sharp is still a dependency, because Astro uses it to generate
srcset variants at build; that install happens on Cloudflare's own build
container and resolves its own binary.

## Fonts

Eight woff2 files vendored into `src/fonts/`, declared in `src/styles/fonts.css`,
with `--font-display` / `--font-ui` defined in `tokens.css`. Committed rather
than installed — 140KB of static files does not need to be a dependency, and
this way the site builds with no network at all.

Deliberately **not** Astro's font provider API. That API fetches from
fonts.google.com at build time, so every deploy depends on a third party being
reachable from Cloudflare's build container — and when it isn't, the build still
*succeeds*, emits no `@font-face`, leaves the CSS variables undefined, and
silently ships the entire site in the browser's default serif. An npm dependency
cannot fail that way. (This is not hypothetical; it is exactly what happened
here first time round.)

## The landing page

`src/pages/index.astro` — the design system's ScrollStage. **One tile per
project**, not per image, held at 58% down the viewport and travelling sideways
at 1.25× as the page scrolls down.

Two layers of behaviour. Without JS, on touch, on a narrow screen, or under
`prefers-reduced-motion`, it stays a plain horizontal strip you swipe: same
tiles, same position, nothing hijacked. With a fine pointer on a wide screen the
strip is lifted into a fixed layer — four shuffled passes of the projects are
cloned into one loop, each tile's position is wrapped modulo the loop length,
and scrolling past the loop silently resets the page by exactly one loop. The
strip is periodic, so the seam is invisible and the scroll never ends. Repeat
passes are `aria-hidden` so it is not an endless list to a screen reader.

Each tile's photograph is drawn from that project's `landing` pool by an inline
pre-paint script, so only the picked variant is ever fetched and the clones
inherit it: a project shows the *same* photograph every time it comes round, and
a different one on refresh.

Desktop reveals the caption on hover and lifts the tile; touch keeps the caption
visible, since there is no hover to reward.

## Structure

```
src/
  content.config.ts     schema + the closed tag taxonomy
  lib/gallery.ts        folder-derived galleries, credits, the landing pool
  content/projects/     one .md per project
  content/services/     one .md per tag — validation and display titles only
  components/           Nav, Footer, ServiceTags
  layouts/Base.astro    the shell every page renders into
  pages/                index, about, contact, 404, projects/*
  styles/tokens.css     design system tokens — values are verbatim, don't drift
scripts/
  build_assets.py       the real image pipeline (Python + Pillow)
  dev-placeholders.mjs  stand-in imagery for machines without the masters
worker/                 the contact endpoint + the asset fallback
```

## Still open

- The about page, the projects index and the contact page all still carry
  `[TO WRITE]` headings. An earlier AI-written draft of the about copy was
  removed; only Jess's own words go back in. See the no-AI-text rule in
  `AGENTS.md` — `grep -rn "TO WRITE" src/` lists every gap.
- Alt text falls back to "Project — Location" where nothing better is set.
  Worth a pass with Jess on the images that carry the most weight.
- `hello@jesselliot.com` is hardcoded in the contact page and the enquiry
  function's error copy. Change both if the address differs.
- Per-project OG images are the project cover. Fine, but a purpose-made card
  would read better when shared.
