/*
 * Reports dimensions, transparency and dominant colours for supplied brand
 * assets, so palette tokens can be checked against the real artwork rather
 * than eyeballed. Run: node scripts/inspect-assets.mjs <file>...
 */
import sharp from 'sharp';

const files = process.argv.slice(2);
if (!files.length) {
	console.error('usage: node scripts/inspect-assets.mjs <image>...');
	process.exit(1);
}

const hex = (n) => Math.round(n).toString(16).padStart(2, '0');

for (const f of files) {
	const meta = await sharp(f).metadata();
	console.log(`\n=== ${f.split('/').pop()}`);
	console.log(
		`  ${meta.width}x${meta.height} ${meta.format} alpha=${meta.hasAlpha} channels=${meta.channels}`,
	);

	try {
		const t = await sharp(f).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
		console.log(`  artwork bounds after trim: ${t.info.width}x${t.info.height}`);
	} catch (e) {
		console.log(`  trim failed: ${e.message}`);
	}

	// Opaque pixels only, quantised, so transparent padding doesn't skew things.
	const { data, info } = await sharp(f)
		.resize(80, 80, { fit: 'inside' })
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	const buckets = new Map();
	let opaque = 0;
	for (let i = 0; i < data.length; i += info.channels) {
		const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
		if (a < 200) continue;
		opaque++;
		const key = [r, g, b].map((v) => Math.round(v / 24) * 24).join(',');
		const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
		e.n++;
		e.r += r;
		e.g += g;
		e.b += b;
		buckets.set(key, e);
	}

	const total = [...buckets.values()].reduce((s, e) => s + e.n, 0);
	console.log(`  opaque coverage: ${((opaque / (info.width * info.height)) * 100).toFixed(0)}%`);
	[...buckets.values()]
		.sort((a, b) => b.n - a.n)
		.slice(0, 6)
		.forEach((e) => {
			console.log(
				`  #${hex(e.r / e.n)}${hex(e.g / e.n)}${hex(e.b / e.n)}  ${((e.n / total) * 100).toFixed(1)}%`,
			);
		});
}
