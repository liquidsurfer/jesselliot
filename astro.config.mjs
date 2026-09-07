// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
	site: 'https://jesselliot.com',

	integrations: [
		mdx(),
		sitemap(),
	],

	image: {
		// Every <Image> is responsive by default: Astro emits a srcset and the
		// sizing CSS, so we never hand-write breakpoints per image.
		layout: 'constrained',
		responsiveStyles: true,
		objectFit: 'cover',
		objectPosition: 'center',
	},

	// Fonts are self-hosted via @fontsource-variable packages, imported in
	// src/styles/global.css, with --font-display / --font-ui defined in
	// tokens.css.
	//
	// Deliberately NOT Astro's font provider API. That API fetches from
	// fonts.google.com at build time, which makes every deploy depend on a
	// third-party host being reachable from Cloudflare's build container — and
	// when it isn't, the build still succeeds, emits no @font-face, leaves the
	// CSS variables undefined and silently ships the whole site in the browser's
	// default serif. A npm dependency cannot fail that way.
});
