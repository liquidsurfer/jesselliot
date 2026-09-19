#!/usr/bin/env node
/**
 * Layout regression check — does any page scroll sideways?
 *
 * A portfolio should never scroll horizontally. Two places on this site are
 * *meant* to move sideways — the landing strip and Enigma's signs band — but
 * both scroll inside themselves, not by widening the document.
 *
 * Why this exists: the polaroid cluster on a project page shipped at 122% of
 * its own column (three 58% frames with only 26% of overlap). The grid column
 * was `minmax(0, …)` so the column held, and the content simply spilled out
 * and dragged the document's scroll width with it. Nothing in the build failed
 * and nothing looked wrong until someone opened the page. That is exactly the
 * class of bug a build cannot catch and a browser can.
 *
 * It deliberately does not fix anything, and there is deliberately no
 * `overflow-x: clip` anywhere in the stylesheets: clipping hides this symptom
 * while leaving the component the wrong size.
 *
 * Usage:
 *     npm run check              # build output, all routes, three widths
 *     npm run check -- --url http://localhost:4321   # against a running dev server
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';

const DIST = new URL('../dist', import.meta.url).pathname;

/*
	The widths worth checking: a typical laptop, the point just above the
	860px/800px breakpoints where the two-column layouts are at their most
	cramped, and a small phone. Most overflow bugs live at the second one.
*/
const VIEWPORTS = [
	{ label: 'desktop', width: 1440, height: 900 },
	{ label: 'tablet', width: 880, height: 1000 },
	{ label: 'phone', width: 390, height: 844 },
];

/** A scrollbar or a sub-pixel rounding error is not a layout bug. */
const TOLERANCE = 2;

/*
	The design-layer invariants. Each one is a rule the layout is supposed to
	follow, and each was violated at some point by code that built and looked
	fine — which is the whole argument for checking them mechanically rather
	than by eye.
*/
/** Jess's homepage strip is one box repeated. Tiles must not vary. */
const TILE_SPREAD = 1;
/**
 * No collage row may tower over the page, measured off her own mockups: the
 * Medicine Field collage runs 472-656px at 1440, the Graphics page tops out
 * near 523px. The ceiling sits just above her largest.
 */
const MAX_ROW = 690;
/** Footer gap should be the same on every page that has one. */
const FOOT_TOLERANCE = 8;

/** Routes are read from the build, so a new page is covered without an edit here. */
function routes() {
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (entry === 'index.html') {
				const rel = relative(DIST, full).replace(/index\.html$/, '');
				found.push('/' + rel);
			} else if (entry === '404.html') {
				// Served for anything unmatched, so it is a real page too.
				found.push('/' + relative(DIST, full));
			}
		}
	};
	walk(DIST);
	return found.sort();
}

/*
	Runs in the page. Reports the document's overflow and, more usefully, names
	the elements sticking out past the right edge — "the page is 80px too wide"
	sends you hunting, "this figure ends at 1520px" does not.

	Anything inside a scroll container of its own is skipped: a wide child of
	`overflow-x: auto` is the whole point of that container, not a bug.
*/
const PROBE = () => {
	const doc = document.documentElement;
	const limit = doc.clientWidth;

	const scrolls = (el) => {
		const o = getComputedStyle(el).overflowX;
		return o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip';
	};

	const culprits = [];
	for (const el of document.body.querySelectorAll('*')) {
		const rect = el.getBoundingClientRect();
		if (rect.width === 0 || rect.right <= limit + 2) continue;

		let inRail = false;
		for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
			if (scrolls(p)) {
				inRail = true;
				break;
			}
		}
		if (inRail) continue;

		// Only the outermost offender of a nest is worth naming; its children
		// overflow because it does.
		if (culprits.some((c) => c.el.contains(el))) continue;

		const id = el.id ? `#${el.id}` : '';
		const cls = typeof el.className === 'string' && el.className
			? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
			: '';
		culprits.push({ el, label: `${el.tagName.toLowerCase()}${id}${cls}`, right: Math.round(rect.right) });
	}

	return {
		scrollWidth: doc.scrollWidth,
		clientWidth: limit,
		culprits: culprits.slice(0, 5).map(({ label, right }) => ({ label, right })),
	};
};

/** The design-layer probe. Runs in the page; returns only what it can see. */
const RULES = () => {
	const round = (n) => Math.round(n);

	// Homepage tiles: one box, repeated.
	const frames = [...document.querySelectorAll('[data-box] .frame')]
		.map((e) => e.getBoundingClientRect())
		.filter((r) => r.width > 1);
	const tiles = frames.length
		? {
				count: frames.length,
				wSpread: Math.max(...frames.map((r) => round(r.width))) - Math.min(...frames.map((r) => round(r.width))),
				hSpread: Math.max(...frames.map((r) => round(r.height))) - Math.min(...frames.map((r) => round(r.height))),
			}
		: null;

	// Collage rows: none allowed to dominate.
	const rows = [...document.querySelectorAll('.gallery-row, .rows > .row')]
		.map((e) => round(e.getBoundingClientRect().height));

	// A protected image must never be cropped to fill a box.
	const cropped = [...document.querySelectorAll('img[data-crop="protect"]')]
		.filter((img) => getComputedStyle(img).objectFit === 'cover')
		.map((img) => img.getAttribute('src') || '(unnamed)');

	// Distance from the last content to the footer.
	const footer = document.querySelector('.site-footer');
	let footGap = null;
	if (footer) {
		const fTop = footer.getBoundingClientRect().top + window.scrollY;
		let lowest = 0;
		for (const el of document.querySelectorAll('main *')) {
			const r = el.getBoundingClientRect();
			if (r.height > 0) lowest = Math.max(lowest, r.bottom + window.scrollY);
		}
		footGap = round(fTop - lowest);
	}

	return { tiles, rows, cropped, footGap };
};

async function main() {
	const urlArg = process.argv.indexOf('--url');
	const base = urlArg > -1 ? process.argv[urlArg + 1] : null;

	if (!base && !existsSync(DIST)) {
		console.error('No dist/ — run `npm run build` first, or pass --url.');
		process.exit(1);
	}

	let server;
	let origin = base;

	if (!origin) {
		// `astro preview` serves the real build, so what is measured is what
		// ships rather than what the dev server happens to render.
		server = spawn('npx', ['astro', 'preview', '--port', '4399'], { stdio: 'ignore' });
		origin = 'http://localhost:4399';
		for (let i = 0; i < 40; i++) {
			try {
				await fetch(origin);
                break;
			} catch {
				await new Promise((r) => setTimeout(r, 250));
			}
		}
	}

	// Routes always come from the build, even when checking a dev server —
	// the two serve the same set, and dist/ is the enumerable one.
	const paths = routes();
	const browser = await chromium.launch();
	const failures = [];
	const footGaps = [];

	console.log(`Checking ${paths.length} route(s) at ${VIEWPORTS.length} widths — ${origin}\n`);

	for (const viewport of VIEWPORTS) {
		const page = await browser.newPage({
			viewport: { width: viewport.width, height: viewport.height },
		});

		for (const path of paths) {
			await page.goto(origin + path, { waitUntil: 'load' });
			// Images are lazy and the landing strip lays itself out on rAF.
			await page.waitForTimeout(250);

			const result = await page.evaluate(PROBE);
			const over = result.scrollWidth - result.clientWidth;

			if (over > TOLERANCE) {
				failures.push({ path, viewport: viewport.label, over, ...result });
				console.log(`  ✗ ${viewport.label.padEnd(8)} ${path} — ${over}px too wide`);
				for (const c of result.culprits) {
					console.log(`      ${c.label} ends at ${c.right}px (viewport ${result.clientWidth}px)`);
				}
			}

			// The design-layer rules only make sense at desktop width; below the
			// breakpoints the grids deliberately unwind into single columns.
			if (viewport.label !== 'desktop') continue;

			// Lazy images and the driven strip need a beat to settle.
			await page.evaluate(async () => {
				window.scrollTo(0, document.body.scrollHeight);
				await new Promise((r) => setTimeout(r, 700));
				window.scrollTo(0, 0);
			});
			await page.waitForTimeout(250);
			const rules = await page.evaluate(RULES);

			if (rules.tiles && (rules.tiles.wSpread > TILE_SPREAD || rules.tiles.hSpread > TILE_SPREAD)) {
				failures.push({ path, rule: 'tiles' });
				console.log(`  ✗ tiles    ${path} — strip is not uniform `
					+ `(width varies by ${rules.tiles.wSpread}px, height by ${rules.tiles.hSpread}px across ${rules.tiles.count})`);
			}

			const tallest = rules.rows.length ? Math.max(...rules.rows) : 0;
			if (tallest > MAX_ROW) {
				failures.push({ path, rule: 'row-height' });
				console.log(`  ✗ collage  ${path} — row of ${tallest}px exceeds the ${MAX_ROW}px ceiling`);
			}

			if (rules.cropped.length) {
				failures.push({ path, rule: 'crop' });
				console.log(`  ✗ crop     ${path} — ${rules.cropped.length} framed image(s) cropped to fill:`);
				for (const c of rules.cropped.slice(0, 3)) console.log(`      ${c}`);
			}

			if (rules.footGap !== null) footGaps.push({ path, gap: rules.footGap });

			// The homepage hover grows a tile by changing its real size. Done
			// with a transform instead, the caption stays put and ends up
			// inside the photograph — which is what it did before this check
			// existed.
			if (path === '/' && rules.tiles) {
				// Reload first. The strip is driven from scrollY and wraps the
				// page position as it goes, so after the lazy-image scroll above
				// the tiles are still moving and any coordinate measured here is
				// stale by the time the pointer arrives. A fresh load puts the
				// strip at rest.
				await page.goto(origin + path, { waitUntil: 'load' });
				await page.waitForTimeout(600);

				const tagged = await page.evaluate(() => {
					const boxes = [...document.querySelectorAll('[data-box]')].filter((e) => {
						const r = e.getBoundingClientRect();
						return r.width > 1 && r.left > 320 && r.right < 1020;
					});
					if (!boxes.length) return false;
					boxes[0].setAttribute('data-probe', '1');
					return true;
				});

				if (!tagged) {
					// Silence here would look like a pass, which is the failure
					// mode this whole script exists to avoid.
					console.log('  ! hover     / — no tile in range to probe; check skipped');
				} else {
					// locator.hover() re-reads the element's position at the
					// moment it moves, so it cannot chase a stale coordinate.
					await page.locator('[data-probe]').hover();
					await page.waitForTimeout(700);
					const hover = await page.evaluate(() => {
						const el = document.querySelector('[data-probe]');
						const f = el.querySelector('.frame').getBoundingClientRect();
						const c = el.querySelector('figcaption').getBoundingClientRect();
						return {
							hovered: el.matches(':hover'),
							capTop: Math.round(c.top),
							bottom: Math.round(f.bottom),
						};
					});
					if (!hover.hovered) {
						console.log('  ! hover     / — pointer did not land on a tile; check skipped');
					} else if (hover.capTop < hover.bottom - 1) {
						failures.push({ path, rule: 'hover-caption' });
						console.log(`  ✗ hover     / — caption sits ${hover.bottom - hover.capTop}px `
							+ `inside the grown tile instead of below it`);
					}
					await page.mouse.move(0, 0);
				}
			}
		}

		await page.close();
		console.log(`  ${viewport.label} done`);
	}

	await browser.close();
	if (server) server.kill();

	// One page ending tighter than the rest is the kind of thing nobody spots
	// and everybody feels.
	if (footGaps.length > 1) {
		const gaps = footGaps.map((f) => f.gap);
		const spread = Math.max(...gaps) - Math.min(...gaps);
		if (spread > FOOT_TOLERANCE) {
			failures.push({ rule: 'foot-rhythm' });
			console.log(`\n  ✗ rhythm   footer gap varies by ${spread}px across pages:`);
			for (const f of footGaps.sort((a, b) => a.gap - b.gap)) {
				console.log(`      ${String(f.gap).padStart(4)}px  ${f.path}`);
			}
		}
	}

	console.log('');
	if (failures.length) {
		console.log(`${failures.length} route/width combination(s) scroll sideways.`);
		process.exit(1);
	}
	console.log(`${paths.length} route(s) at ${VIEWPORTS.length} widths: no overflow, `
		+ `strip uniform, hover opens correctly, no row over ${MAX_ROW}px, `
		+ `no framed image cropped, footer rhythm even.`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
