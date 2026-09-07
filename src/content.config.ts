import { defineCollection, reference, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The tag vocabulary. These are no longer a browsable section of the site —
 * there are no /services/ routes. The collection survives only so that a tag
 * on a project is checked against a known slug at build time, and so the
 * display titles live in one place.
 */
export const SERVICES = [
	'creative-direction',
	'stage-design',
	'immersive-installation',
	'scenic-painting',
	'decor-and-props',
	'fabrication',
] as const;

export type ServiceSlug = (typeof SERVICES)[number];

/**
 * Per-image overrides, keyed by the derived filename (e.g. "enigma-04.jpg").
 * The filesystem manifest is authoritative; anything here wins over it.
 */
const imageMeta = z.object({
	alt: z.string().optional(),
	caption: z.string().optional(),
	credit: z.string().optional(),
	/** Pin an image to the front of the gallery. Lower sorts first. */
	order: z.number().optional(),
});

const projects = defineCollection({
	loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		client: z.string().optional(),
		location: z.string(),
		yearStart: z.number().int(),
		yearEnd: z.number().int().optional(),
		/**
		 * Jess's own description of what she did. Kept as data, but deliberately
		 * rendered NOWHERE — the word "role" must not appear in the UI. The tags
		 * carry this job on the page instead.
		 */
		role: z.string().optional(),
		/** Abstract tags shown on the project. Validated against SERVICES. */
		tags: z.array(z.enum(SERVICES)).min(1),
		summary: z.string(),
		pull: z.string(),
		parent: reference('projects').optional(),

		/**
		 * The single full-screen hero on the project page. A bare filename from
		 * this project's folder, e.g. "enigma-11.jpg". Falls back to the first
		 * gallery image when unset.
		 */
		cover: z.string().optional(),
		/**
		 * The pool the homepage picture box rotates through — one is picked per
		 * page load. Bare filenames. Empty means "fall back to the cover".
		 */
		landing: z.array(z.string()).default([]),

		defaultCredit: z.string().optional(),
		credits: z.array(z.string()).default([]),
		images: z.record(imageMeta).default({}),
		order: z.number().int().default(50),
		draft: z.boolean().default(false),
	}),
});

const services = defineCollection({
	loader: glob({ base: './src/content/services', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		order: z.number().int().default(50),
	}),
});

export const collections = { projects, services };
