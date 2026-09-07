#!/usr/bin/env node
/**
 * Generates stand-in imagery so the site can be built and reviewed on a machine
 * that does not have Jess's masters. Never run this against a real checkout you
 * intend to deploy — `npm run assets` is the real pipeline.
 *
 *   node scripts/dev-placeholders.mjs
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT_ROOT = path.join(process.cwd(), 'src/assets/projects');

// Counts match the real folders in ~/Desktop/Jess/JESS PORTFOLIO IMAGES,
// minus the .mov files which are out of scope for v1.
const PROJECTS = [
	{ slug: 'enigma', count: 41, hues: ['#c46a38', '#b0543a', '#f0913c', '#2b1a16'] },
	{ slug: 'medicine-field', count: 14, hues: ['#8a8b73', '#e0a356', '#6e7e88', '#3a342e'] },
	{ slug: 'senses-the-garden', count: 36, hues: ['#f0a8c0', '#f0d8c0', '#9a5f6b', '#f078a8'] },
	{ slug: 'palapa', count: 22, hues: ['#6b635a', '#8a8b73', '#a9a199', '#3a342e'] },
	{ slug: 'sandlantis', count: 12, hues: ['#e0a356', '#c46a38', '#f1eae0', '#6b635a'] },
	{ slug: 'nadia-editorial', count: 14, hues: ['#f078a8', '#6e7e88', '#f0d8c0', '#b0543a'] },
];

const RATIOS = [
	[3, 2],
	[2, 3],
	[4, 5],
	[16, 9],
	[1, 1],
	[5, 4],
	[3, 4],
];

const CREDITS = [null, 'Diary of Ross', null, null, 'Christian Doppelgatz', null];

for (const { slug, count, hues } of PROJECTS) {
	const dir = path.join(OUT_ROOT, slug);
	if (existsSync(dir)) await rm(dir, { recursive: true });
	await mkdir(dir, { recursive: true });

	const manifest = [];

	for (let i = 0; i < count; i++) {
		const [rw, rh] = RATIOS[i % RATIOS.length];
		const width = 1400;
		const height = Math.round((width * rh) / rw);
		const a = hues[i % hues.length];
		const b = hues[(i + 2) % hues.length];
		const file = `${slug}-${String(i + 1).padStart(2, '0')}.jpg`;

		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
			<defs>
				<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0%" stop-color="${a}"/>
					<stop offset="100%" stop-color="${b}"/>
				</linearGradient>
			</defs>
			<rect width="100%" height="100%" fill="url(#g)"/>
			<text x="50%" y="50%" text-anchor="middle" font-family="Georgia,serif"
				font-size="${Math.round(width / 22)}" fill="#faf7f2" opacity="0.72">
				${slug} ${i + 1}
			</text>
		</svg>`;

		await sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toFile(path.join(dir, file));

		manifest.push({
			file,
			source: `PLACEHOLDER-${i + 1}.jpg`,
			width,
			height,
			orientation: width >= height ? 'landscape' : 'portrait',
			credit: CREDITS[i % CREDITS.length],
		});
	}

	await writeFile(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
	console.log(`  ✓ ${slug}: ${count} placeholders`);
}

console.log('\nPlaceholders written. Replace with `npm run assets` on Jess\'s machine.');
