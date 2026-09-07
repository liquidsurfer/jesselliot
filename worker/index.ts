/**
 * The Worker in front of the static site.
 *
 * Cloudflare serves a matching static asset without ever invoking this code.
 * Only requests that match no asset arrive here — which is exactly two cases:
 *
 *   · POST /api/enquiry — the contact form, handled below.
 *   · anything else     — handed back to the assets binding, which applies
 *                         not_found_handling: "404-page" and serves 404.html.
 *
 * This replaces a Pages Function at the same path. Pages Functions do not run
 * on Workers, so the handler had to move here for the contact form to work at
 * all in production.
 */
import { handleEnquiry, type EnquiryEnv } from './enquiry';

interface Env extends EnquiryEnv {
	/** Configured as assets.binding in wrangler.jsonc. */
	ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/api/enquiry') {
			if (request.method !== 'POST') {
				return new Response('Method not allowed', {
					status: 405,
					headers: { allow: 'POST' },
				});
			}
			return handleEnquiry(request, env);
		}

		return env.ASSETS.fetch(request);
	},
};
