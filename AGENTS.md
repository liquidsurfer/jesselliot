## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Content rule — no AI-generated text

**No copy on this site may be written by an AI. Ever.** Not headings, not ledes, not project
descriptions, not microcopy, not "just a placeholder sentence to show the layout".

Where copy is missing, ship a visible placeholder instead:

```astro
<h1 class="pending">[TO WRITE]</h1>
```

`.pending` is defined in `src/styles/base.css` and renders grey and plain, so a gap reads as a gap.
`grep -rn "TO WRITE" src/` lists everything still waiting on Jess.

This applies to text that *sounds* factual too — a plausible-sounding sentence about a project is
worse than an obvious blank, because nobody catches it later. Text derived mechanically from
project data (a list of clients, a year range) is fine; prose about the work is not.
