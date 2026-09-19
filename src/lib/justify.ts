/**
 * Justified rows — the layout Jess drew for the project galleries and the
 * Graphics page.
 *
 * Every image keeps its own proportions, and each row is scaled so the row
 * fills the full width exactly. Rows therefore have different heights, and
 * a landscape shot naturally takes more of its row than a portrait one. It is
 * the layout photo galleries have used for years, and it is what her
 * "photo collage showcase" examples are.
 *
 * Two halves, deliberately split:
 *
 *   · Row breaking happens here, at build time, against a notional container
 *     width. Which images share a row is an editorial rhythm — it should be
 *     the same for everyone, not a function of the visitor's window.
 *
 *   · Row *sizing* is left to CSS. Each image is given `flex: <aspect> 1 0%`,
 *     so widths within a row come out proportional to aspect ratio and the
 *     row's height falls out as width ÷ sum-of-aspects. That makes the layout
 *     fully fluid with no client JS, no measuring and no layout shift — the
 *     dimensions are already in `_manifest.json`.
 */

/** Anything with a known shape. `aspect` is width ÷ height. */
export type Justifiable = { aspect: number; luminance?: number };

/**
 * A cell in a laid-out row. `filler` cells hold no image: they close a short
 * final row so its neighbours keep the height of the row above, instead of
 * two leftovers stretching across the full width. It is how you close an
 * album page — the empty squares are part of the composition.
 */
export type Cell<T> = { image: T | null; aspect: number };

/**
 * The notional width rows are broken against. Not a real breakpoint — it only
 * sets how many images tend to land in a row, since CSS does the real sizing.
 */
const CANVAS = 1200;

export type JustifyOptions = {
	/**
	 * Roughly how tall a row should be at CANVAS width. Bigger means fewer,
	 * larger images per row.
	 */
	targetRowHeight: number;
	/** Never put more than this many in one row. */
	maxPerRow?: number;
	/**
	 * Ceiling on row height, in the same canvas units as targetRowHeight.
	 * A row is only as tall as the width divided by its aspect sum, so a row
	 * with too few images in it towers over the page. This is the backstop.
	 */
	maxRowHeight?: number;
};

/**
 * Prefer a break that puts a light image next to a dark one.
 *
 * Breaking purely on width is what makes a gallery feel mechanical: two dark
 * frames land side by side because that is where the arithmetic fell, not
 * because anyone chose it. Where a row is within tolerance of full either
 * way, this picks the option with more tonal contrast across the row.
 *
 * It only ever moves a break by one image, so Jess's order is preserved
 * exactly — the sequence is hers, only the line endings are ours.
 */
function contrastOf<T extends Justifiable>(row: T[]): number {
	const lums = row.map((i) => (typeof i.luminance === 'number' ? i.luminance : 0.5));
	return lums.length < 2 ? 0 : Math.max(...lums) - Math.min(...lums);
}

/**
 * Group images into rows. Order is preserved — this never reorders Jess's
 * sequence, it only decides where the line breaks fall.
 */
export function justifyRows<T extends Justifiable>(
	images: T[],
	{ targetRowHeight, maxPerRow = 6, maxRowHeight }: JustifyOptions,
): Cell<T>[][] {
	// Minimum aspect sum a row needs to stay under the height ceiling.
	const floor = maxRowHeight ? CANVAS / maxRowHeight : 0;
	const safeAspect = (i: T) =>
		Number.isFinite(i.aspect) && i.aspect > 0 ? i.aspect : 1;

	const rows: T[][] = [];
	let row: T[] = [];
	let aspectSum = 0;

	for (let index = 0; index < images.length; index++) {
		const image = images[index];
		row.push(image);
		aspectSum += safeAspect(image);

		// The row is full once laying it out at the target height would overrun
		// the canvas — that is the point where scaling it down to fit gives
		// roughly the height we asked for.
		//
		// The height ceiling outranks maxPerRow. Three tall portraits can sum
		// to less than the floor, and closing the row there would render it
		// taller than anything in Jess's collages; better a row of four than a
		// row that towers. maxPerRow is a preference, the ceiling is a rule.
		const wide = aspectSum * targetRowHeight >= CANVAS || row.length >= maxPerRow;
		const full = wide && aspectSum >= floor;
		if (!full) continue;

		// Within tolerance of full either way, take the more tonally varied
		// row: stopping one short, or reaching one further.
		const next = images[index + 1];
		if (next && row.length > 1 && row.length < maxPerRow) {
			const shorter = row.slice(0, -1);
			const longer = [...row, next];
			const slack = (aspectSum + safeAspect(next)) * targetRowHeight;
			const canExtend = slack <= CANVAS * 1.25;
			const best = Math.max(
				contrastOf(row),
				contrastOf(shorter),
				canExtend ? contrastOf(longer) : -1,
			);
			if (best > contrastOf(row) + 0.04) {
				if (canExtend && contrastOf(longer) === best) {
					row = longer;
					index += 1;
				} else if (contrastOf(shorter) === best) {
					// Dropping an image makes the row taller. Only do it if the
					// result still clears the ceiling — tonal variety is a
					// preference, row height is a rule.
					const shortSum = shorter.reduce((s, i) => s + safeAspect(i), 0);
					if (shortSum >= floor) {
						row = shorter;
						index -= 1;
					}
				}
			}
		}

		rows.push(row);
		row = [];
		aspectSum = 0;
	}

	if (row.length) rows.push(row);

	return close(rows, maxPerRow, floor);
}

/**
 * Close the last row.
 *
 * A short final row still carries `flex-grow`, so two leftovers stretch to
 * fill the width and tower over everything above them — a 995px row under a
 * page of 300px ones. Padding the remaining track with empty cells keeps the
 * images at the height of the row above and leaves white where the
 * photographs ran out, which is what the eye expects at the end of a sequence.
 */
function close<T extends Justifiable>(
	rows: T[][],
	maxPerRow: number,
	floor: number,
): Cell<T>[][] {
	const sumOf = (row: T[]) =>
		row.reduce(
			(sum, image) => sum + (Number.isFinite(image.aspect) && image.aspect > 0 ? image.aspect : 1),
			0,
		);

	return rows.map((row, i) => {
		const cells: Cell<T>[] = row.map((image) => ({
			image,
			aspect: Number.isFinite(image.aspect) && image.aspect > 0 ? image.aspect : 1,
		}));
		const last = i === rows.length - 1;
		if (!last) return cells;

		// A closing row matches the row above so it reads as part of the grid.
		// With no row above — a gallery of one row — it still has to clear the
		// height ceiling, or a single pair of portraits fills the screen.
		const target = rows.length > 1 ? sumOf(rows[i - 1]) : floor;
		const have = cells.reduce((sum, c) => sum + c.aspect, 0);
		const missing = target - have;
		if (missing > 0.08 && cells.length <= maxPerRow) {
			cells.push({ image: null, aspect: missing });
		}
		return cells;
	});
}

/**
 * The target row height for a collection of a given size.
 *
 * Jess: "If there are less Photos in the project you can make some bigger. If
 * there are more Photos in the project make them smaller and space them out
 * accordingly." That is this function.
 */
export function targetHeightFor(count: number): number {
	if (count <= 6) return 540;
	if (count <= 12) return 500;
	if (count <= 20) return 450;
	return 400;
}

/**
 * The tallest a project-gallery row may be, in canvas units.
 *
 * Measured off Jess's Medicine Field collage: her rows run 472-656px at a
 * 1440 viewport, so ~547 at canvas width. The earlier values here produced
 * rows of 753px, half again her largest.
 */
export const MAX_GALLERY_ROW = 560;

/**
 * The flex shorthand that sizes a cell within its row. Growing in proportion
 * to aspect ratio is what makes every image in a row share one height.
 */
export function flexFor(cell: { aspect: number }): string {
	const aspect = Number.isFinite(cell.aspect) && cell.aspect > 0 ? cell.aspect : 1;
	return `${aspect.toFixed(4)} 1 0%`;
}
