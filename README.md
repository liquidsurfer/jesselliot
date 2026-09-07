# jesselliot.com

Portfolio site for Jess Elliot — stage design, scenic painting and immersive
environments. Astro, static output, deployed to Cloudflare Pages.

## Getting it running

Requires Python 3 with Pillow (`pip3 install --user Pillow`) for the image
pipeline, and Node for the site itself.

```bash
pnpm install
npm run assets     # derive web images from the masters (see below) — do this first
npm run dev
```

`npm run assets` (Python + Pillow) reads Jess's masters from `~/Desktop/Jess/JESS PORTFOLIO IMAGES`
and writes web-ready copies into `src/assets/projects/<slug>/`. Override the
source location with `JESS_SOURCE=/some/path npm run assets`. Nothing renders
until this has run at least once.

## How the images work

The masters are ~2.1GB with single files up to 41MB. They are **not** in the
repo and never should be. `scripts/build_assets.py` downsizes each to 2560px
on the longest edge at q80 mozjpeg (~600KB) and writes them with deterministic
names — `enigma-01.jpg`, `enigma-02.jpg` and so on, in sorted order.

Those derived files **are** committed, because Cloudflare Pages builds from this
repo and has no access to Jess's disk. About 100MB total, which git handles
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
images:
  enigma-04.jpg:
    alt: The tree booth at dusk, lit from below
    caption: Booth façade, 2024 edition
    credit: Diary of Ross
    order: 1                # pin to the front of the gallery
  enigma-19.jpg:
    excludeFromDrift: true  # keep off the landing page, still on the project page
```

### Why 2560px

Cloudflare Pages free tier caps a single asset at 25 MiB and a deployment at
20,000 files. Astro emits ~5 srcset variants per image, so ~139 images is ~810
files — comfortably inside both. Feeding sharp a 2560px master rather than a
41MB original is also what keeps the Pages build inside its 20-minute timeout;
a full build currently takes about 45 seconds.

### Videos

The seven `.mov` files in the source folders (13–19MB each) are skipped. Astro
does not optimise video, and they would each eat most of the per-asset budget.
If they come back, convert to muted looping webm/mp4 first and add a `video`
field to the schema.

## Content

- `src/content/projects/*.md` — one file per project. Sub-projects (Lamps)
  point at their parent with `parent:`, and are listed under it rather than
  beside it.
- `src/content/services/*.md` — one per service. The taxonomy is a **closed
  set** defined in `src/content.config.ts`; it drives the nav dropdown, the tags
  and the per-service pages, so a tag outside the list fails the build rather
  than creating a dead end.

Three projects are `draft: true` and appear nowhere on the site or in the
sitemap, though their pages still build so they can be reviewed on a Pages
preview URL:

| Project | Blocked on |
|---|---|
| The Nest | No photography in the source folders |
| Lamps | Same, and it is a child of The Nest |
| Editorial — Nadia | No write-up anywhere; see the note in the file |

## Deploying to Cloudflare Pages

Framework preset **Astro**, build command `npm run build`, output directory
`dist`. Everything stays inside the free tier.

The contact form is the only server-side code: `functions/api/enquiry.ts`, a
Pages Function. Pages serves static assets and cannot accept a POST on its own.

Set these in **Settings → Environment variables** (and in a local `.dev.vars`
for `wrangler pages dev`):

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

Six woff2 files vendored into `src/fonts/`, declared in `src/styles/fonts.css`,
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

`src/pages/index.astro`. Every published image, shuffled **per visit** in an
inline pre-paint script — not per build, since a Pages build only runs on
deploy. The layout rhythm is a fixed nine-slot pattern; only the content is
random, because genuinely random placement looks accidental about a third of the
time.

Desktop hovers to reveal the caption and dims the rest; touch shows a small
persistent caption and opens the project on tap. After four shuffled cycles it
stops and offers a way through to the projects — an endless scroll has no exit.

## Structure

```
src/
  content.config.ts     schema + the closed service taxonomy
  lib/gallery.ts        folder-derived galleries, credits, the landing pool
  content/projects/     one .md per project
  content/services/     one .md per service
  pages/                index, about, contact, 404, projects/*, services/*
  styles/tokens.css     design system tokens — values are verbatim, don't drift
scripts/
  build_assets.py       the real image pipeline (Python + Pillow)
  dev-placeholders.mjs  stand-in imagery for machines without the masters
functions/api/          the contact endpoint
```

## Still open

- About page copy is a draft written from Jess's own project prose, in third
  person. It needs her eye — see the comment at the top of `src/pages/about.astro`.
- Alt text falls back to "Project — Location" where nothing better is set.
  Worth a pass with Jess on the images that carry the most weight.
- `hello@jesselliot.com` is hardcoded in the contact page and the enquiry
  function's error copy. Change both if the address differs.
- Per-project OG images are the project cover. Fine, but a purpose-made card
  would read better when shared.
