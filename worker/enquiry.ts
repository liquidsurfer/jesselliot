/**
 * Enquiry endpoint, called from worker/index.ts for POST /api/enquiry.
 *
 * The site is otherwise entirely static; this is the one piece of server-side
 * code. It stays inside the Workers free tier (100k requests/day; this will
 * see single digits).
 *
 * Required secrets, set with `wrangler secret put <NAME>` or in the dashboard
 * under Workers → jesselliot → Settings → Variables (and in .dev.vars locally):
 *
 *   TURNSTILE_SECRET_KEY   from the Turnstile widget (Cloudflare dashboard)
 *   RESEND_API_KEY         from resend.com — free tier is 3,000 emails/month
 *   ENQUIRY_TO             where enquiries land, e.g. jess@jesselliot.com
 *   ENQUIRY_FROM           a verified sender on the domain, e.g. site@jesselliot.com
 *
 * And one build-time public variable, needed by the form itself — this one is
 * a plain build variable, not a secret, since it ships in the HTML:
 *
 *   PUBLIC_TURNSTILE_SITE_KEY
 *
 * Resend rather than MailChannels: MailChannels ended its free Cloudflare
 * Workers integration, so the old "no API key needed" route is gone.
 */

export interface EnquiryEnv {
	TURNSTILE_SECRET_KEY: string;
	RESEND_API_KEY: string;
	ENQUIRY_TO: string;
	ENQUIRY_FROM: string;
}

const MIN_FILL_MS = 3_000;
const MAX_FIELD = 5_000;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const clean = (value: FormDataEntryValue | null): string =>
	typeof value === 'string' ? value.trim().slice(0, MAX_FIELD) : '';

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		(char) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
	);

async function verifyTurnstile(token: string, secret: string, ip: string | null) {
	if (!token) return false;
	const body = new FormData();
	body.append('secret', secret);
	body.append('response', token);
	if (ip) body.append('remoteip', ip);

	const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		method: 'POST',
		body,
	});
	const result = (await response.json()) as { success?: boolean };
	return result.success === true;
}

export async function handleEnquiry(request: Request, env: EnquiryEnv): Promise<Response> {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'Could not read that submission.' }, 400);
	}

	// Layer 1 — honeypot. Silent success: a bot told it failed will retry.
	if (clean(form.get('company_website'))) {
		return json({ ok: true });
	}

	// Layer 2 — elapsed time. Nobody fills this form in three seconds.
	const started = Number(clean(form.get('started')));
	if (Number.isFinite(started) && started > 0 && Date.now() - started < MIN_FILL_MS) {
		return json({ ok: true });
	}

	// Layer 3 — Turnstile.
	const ip = request.headers.get('CF-Connecting-IP');
	const passed = await verifyTurnstile(
		clean(form.get('cf-turnstile-response')),
		env.TURNSTILE_SECRET_KEY,
		ip,
	);
	if (!passed) {
		return json({ error: 'Verification failed. Please reload and try again.' }, 400);
	}

	const name = clean(form.get('name'));
	const email = clean(form.get('email'));
	const message = clean(form.get('message'));

	if (!name || !email || !message) {
		return json({ error: 'Please fill in your name, email and a message.' }, 400);
	}
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		return json({ error: 'That email address does not look right.' }, 400);
	}

	const services = form
		.getAll('services')
		.map((value) => clean(value))
		.filter(Boolean);

	const rows: [string, string][] = [
		['Name', name],
		['Email', email],
		['Phone', clean(form.get('phone'))],
		['Organisation', clean(form.get('organisation'))],
		['Services', services.join(', ')],
		['Location', clean(form.get('location'))],
		['Budget', clean(form.get('budget'))],
		['Build starts', clean(form.get('dateFrom'))],
		['Event ends', clean(form.get('dateTo'))],
	].filter(([, value]) => value !== '') as [string, string][];

	const html = `
		<h2 style="font-family:Georgia,serif">New enquiry from ${escapeHtml(name)}</h2>
		<table style="font-family:system-ui,sans-serif;font-size:14px;border-collapse:collapse">
			${rows
				.map(
					([label, value]) =>
						`<tr>
							<td style="padding:6px 16px 6px 0;color:#6b635a;vertical-align:top">${label}</td>
							<td style="padding:6px 0">${escapeHtml(value)}</td>
						</tr>`,
				)
				.join('')}
		</table>
		<h3 style="font-family:Georgia,serif;margin-top:24px">Message</h3>
		<p style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-wrap">${escapeHtml(message)}</p>
		<hr style="margin-top:32px;border:none;border-top:1px solid #e4ded6" />
		<p style="font-family:system-ui,sans-serif;font-size:12px;color:#a9a199">
			Sent from the contact form at jesselliot.com
		</p>`;

	const send = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${env.RESEND_API_KEY}`,
			'content-type': 'application/json',
		},
		body: JSON.stringify({
			from: `Jess Elliot site <${env.ENQUIRY_FROM}>`,
			to: [env.ENQUIRY_TO],
			reply_to: email,
			subject: `Enquiry — ${name}${services.length ? ` (${services[0]}${services.length > 1 ? ' +' + (services.length - 1) : ''})` : ''}`,
			html,
		}),
	});

	if (!send.ok) {
		// Don't leak the provider's error to the visitor, but do log it so the
		// Worker logs say why an enquiry never arrived. observability is on in
		// wrangler.jsonc, so this is queryable.
		console.error('Resend failed', send.status, await send.text());
		return json({ error: 'Could not send that just now. Please email hello@jesselliot.com.' }, 502);
	}

	return json({ ok: true });
}
