import type { ImageMetadata } from 'astro';
import type { CollectionEntry } from 'astro:content';

/**
 * Galleries are read from the filesystem, not from frontmatter.
 *
 * scripts/build_assets.py writes src/assets/projects/<slug>/<slug>-NN.jpg plus
 * a _manifest.json carrying the original filename, dimensions and the
 * photographer inferred from that filename. Adding a photo to a project is
 * therefore "drop the file in the folder and rerun the script" — no frontmatter
 * edit, nothing to forget. The `images` map in frontmatter only *overrides* the
 * defaults derived here.
 *
 * Two frontmatter fields do select images by name: `cover` (the project page's
 * full-screen hero) and `landing` (the pool the homepage box rotates through).
 * Both are checked against the manifest at build time — see assertKnownFiles.
 *
 * Neither is usually needed. Jess labels the masters by the job they do —
 * "HERO1.jpg", "TOP LANDSCAPE.jpg", "ENIGMA SIGNS SCROLL.jpg" — and
 * build_assets.py carries that through to the manifest as `role`. So the
 * default cover is the image she marked TOP LANDSCAPE and the default landing
 * pool is the ones she marked HERO. Frontmatter is the override for when her
 * labelling is missing or we want something else, not the normal path.
 */

/** The job Jess's filename assigns an image. See ROLE_PATTERNS in the pipeline. */
export type ImageRole = 'hero' | 'top-landscape' | 'signs';

type ManifestEntry = {
	file: string;
	source: string;
	width: number;
	height: number;
	orientation: 'landscape' | 'portrait';
	credit: string | null;
	/** "protect" means the image has a uniform border and must not be cropped. */
	crop?: 'safe' | 'protect';
	/** Mean brightness 0-1, used to compose gallery rows. */
	luminance?: number;
	/** Mean brightness of the top strip — decides light or dark nav over a hero. */
	topLuminance?: number;
	role?: ImageRole;
	/** Set only on projects split into sections, e.g. Nadia's three shoots. */
	section?: string;
};

export type GalleryImage = {
	src: ImageMetadata;
	file: string;
	alt: string;
	caption?: string;
	credit?: string;
	orientation: 'landscape' | 'portrait';
	aspect: number;
	crop: 'safe' | 'protect';
	luminance: number;
	topLuminance: number;
	role?: ImageRole;
	section?: string;
};

// Eager so the build resolves and hashes every asset; these are ImageMetadata
// objects, not the image bytes, so the cost is small.
const files = import.meta.glob<{ default: ImageMetadata }>(
	'/src/assets/projects/**/*.{jpg,jpeg,png,webp}',
	{ eager: true },
);

const manifests = import.meta.glob<{ default: ManifestEntry[] }>(
	'/src/assets/projects/**/_manifest.json',
	{ eager: true },
);

const keyFor = (slug: string, file: string) => `/src/assets/projects/${slug}/${file}`;

function manifestFor(slug: string): ManifestEntry[] {
	return manifests[`/src/assets/projects/${slug}/_manifest.json`]?.default ?? [];
}

/**
 * Alt text of last resort. A real description written by Jess always beats
 * this, but an unlabelled photograph is worse than a plain one, so every image
 * gets something true rather than an empty string.
 */
function fallbackAlt(project: CollectionEntry<'projects'>) {
	const where = project.data.client ?? project.data.location;
	return `${project.data.title} — ${where}`;
}

/**
 * Fail the build on a filename that does not exist, rather than silently
 * rendering nothing. A typo in `cover:` or `landing:` is otherwise invisible
 * until someone notices the wrong photograph on the homepage.
 */
function assertKnownFiles(project: CollectionEntry<'projects'>, known: Set<string>) {
	const named = [
		...(project.data.cover ? [['cover', project.data.cover] as const] : []),
		...project.data.landing.map((file) => ['landing', file] as const),
	];
	for (const [field, file] of named) {
		if (!known.has(file)) {
			throw new Error(
				`${project.id}: ${field} names "${file}", which is not in ` +
					`src/assets/projects/${project.id}/_manifest.json. ` +
					`Known files: ${[...known].join(', ') || '(none)'}`,
			);
		}
	}
}

export function galleryFor(project: CollectionEntry<'projects'>): GalleryImage[] {
	const slug = project.id;
	const overrides = project.data.images ?? {};
	const entries = manifestFor(slug);

	assertKnownFiles(project, new Set(entries.map((e) => e.file)));

	return entries
		.map((entry) => {
			const mod = files[keyFor(slug, entry.file)];
			if (!mod) return null; // manifest is stale — rerun build_assets.py
			const override = overrides[entry.file] ?? {};
			return {
				src: mod.default,
				file: entry.file,
				alt: override.alt ?? fallbackAlt(project),
				caption: override.caption,
				credit: override.credit ?? entry.credit ?? project.data.defaultCredit ?? undefined,
				orientation: entry.orientation,
				aspect: entry.width / entry.height,
				crop: entry.crop ?? 'safe',
				luminance: entry.luminance ?? 0.5,
				topLuminance: entry.topLuminance ?? 0.5,
				role: entry.role,
				section: entry.section,
				// Un-pinned images sort after pinned ones but otherwise hold manifest
				// order. A large finite number, not Infinity: Infinity - Infinity is
				// NaN, which makes the comparator incoherent.
				_order: override.order ?? Number.MAX_SAFE_INTEGER,
			};
		})
		.filter((x): x is NonNullable<typeof x> => x !== null)
		.sort((a, b) => a._order - b._order)
		.map(({ _order, ...image }) => image);
}

/**
 * The single image that represents the project — the landscape shot that runs
 * across the top of the project page and beside its row on the projects index.
 *
 * Frontmatter `cover` wins; otherwise the one Jess labelled TOP LANDSCAPE;
 * otherwise the first image, so a project always has something.
 */
export function coverFor(project: CollectionEntry<'projects'>): GalleryImage | undefined {
	const gallery = galleryFor(project);
	if (!gallery.length) return undefined;
	const named = project.data.cover && gallery.find((g) => g.file === project.data.cover);
	const labelled = gallery.find((g) => g.role === 'top-landscape');
	return named || labelled || gallery[0];
}

/**
 * Images Jess grouped under a scrolling band of their own — Enigma's signs.
 * They are kept out of the main grid so they are not shown twice.
 */
export function bandFor(project: CollectionEntry<'projects'>): GalleryImage[] {
	return galleryFor(project).filter((image) => image.role === 'signs');
}

/**
 * A sectioned project's images in section order, e.g. Nadia's Womanhood,
 * Still Life and Orion on one page. Empty for everything else.
 */
export function sectionsFor(
	project: CollectionEntry<'projects'>,
): { section: string; images: GalleryImage[] }[] {
	const grouped = new Map<string, GalleryImage[]>();
	for (const image of galleryFor(project)) {
		if (!image.section) continue;
		const bucket = grouped.get(image.section);
		if (bucket) bucket.push(image);
		else grouped.set(image.section, [image]);
	}
	return [...grouped].map(([section, images]) => ({ section, images }));
}

/**
 * The images the homepage box may rotate through for this project. One is
 * picked per page load, client-side. Falls back to the cover so a project with
 * no curated pool still shows something rather than nothing.
 */
export function landingPool(project: CollectionEntry<'projects'>): GalleryImage[] {
	const gallery = galleryFor(project);
	if (!gallery.length) return [];

	const approved = project.data.landing
		.map((file) => gallery.find((image) => image.file === file))
		.filter((image): image is GalleryImage => image !== undefined);

	if (approved.length) return approved;

	// Jess ships three HERO-labelled images per project for exactly this.
	const labelled = gallery.filter((image) => image.role === 'hero');
	if (labelled.length) return labelled;

	const cover = coverFor(project);
	return cover ? [cover] : [];
}
