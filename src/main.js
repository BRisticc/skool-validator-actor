/**
 * Skool Group Validator — Apify Actor
 *
 * Reads a Skool CSV export, fetches live data from each group's /about page,
 * and pushes a comparison dataset (old vs. live members + pricing).
 *
 * Skool uses Next.js, so we extract data from the embedded __NEXT_DATA__ JSON
 * blob rather than parsing HTML — much more reliable.
 */

import { Actor } from 'apify';
import { HttpCrawler, log } from 'crawlee';
import { parse as parseCsv } from 'csv-parse/sync';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts group data from a Skool /about page HTML string.
 * Tries __NEXT_DATA__ JSON first, falls back to regex.
 *
 * @param {string} html
 * @returns {{ members: number|null, monthlyPriceCents: number|null, annualPriceCents: number|null, currency: string|null }}
 */
function extractSkoolData(html) {
    const result = {
        members: null,
        monthlyPriceCents: null,
        annualPriceCents: null,
        currency: null,
    };

    // ── Strategy 1: __NEXT_DATA__ JSON (most reliable) ──────────────────────
    const nextDataMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );

    if (nextDataMatch) {
        try {
            const nextData = JSON.parse(nextDataMatch[1]);

            // Skool nests group info here — path may shift between deploys
            const candidates = [
                nextData?.props?.pageProps?.group,
                nextData?.props?.pageProps?.initialData?.group,
                nextData?.props?.pageProps?.data?.group,
            ];

            for (const group of candidates) {
                if (!group) continue;

                result.members =
                    group.memberCount ??
                    group.totalMembers ??
                    group.numMembers ??
                    null;

                result.monthlyPriceCents =
                    group.monthlyPrice ??
                    group.priceMonthly ??
                    group.price ??
                    null;

                result.annualPriceCents =
                    group.annualPrice ??
                    group.priceAnnual ??
                    null;

                result.currency =
                    group.currency ??
                    group.monthlyPriceCurrency ??
                    'usd';

                if (result.members !== null || result.monthlyPriceCents !== null) {
                    return { ...result, source: 'next_data' };
                }
            }
        } catch (e) {
            log.warning(`__NEXT_DATA__ JSON parse error: ${e.message}`);
        }
    }

    // ── Strategy 2: Regex fallback ──────────────────────────────────────────
    // Member count: "1,234 members" pattern in page text
    const membersMatch = html.match(/"memberCount"\s*:\s*(\d+)/);
    if (membersMatch) result.members = parseInt(membersMatch[1], 10);

    // Monthly price in cents: "$119/month" or "$184/mo"
    const priceMatch = html.match(/"monthlyPrice"\s*:\s*(\d+)/);
    if (priceMatch) result.monthlyPriceCents = parseInt(priceMatch[1], 10);

    const annualMatch = html.match(/"annualPrice"\s*:\s*(\d+)/);
    if (annualMatch) result.annualPriceCents = parseInt(annualMatch[1], 10);

    return { ...result, source: 'regex' };
}

/** Converts Skool price-in-cents to dollars (e.g. 18400 → 184.00) */
function centsToDollars(cents) {
    if (cents === null || cents === undefined || cents === '' || cents === 0) return null;
    return parseFloat((Number(cents) / 100).toFixed(2));
}

/**
 * Parses the input CSV (from URL response body or raw string).
 * Returns an array of { slug, name, oldMembers, oldMonthlyPriceCents, oldAnnualPriceCents }
 */
function parseGroupsFromCsv(csvText) {
    // Auto-detect delimiter: tab-separated or comma-separated
    const firstLine = csvText.split('\n')[0] ?? '';
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    log.info(`CSV delimiter detected: ${delimiter === '\t' ? 'TAB' : 'COMMA'}`);

    const records = parseCsv(csvText, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
        delimiter,
        // TSV files don't use quoting — disable it to avoid parse errors
        // when group_info/group_description contain raw quote characters
        quote: delimiter === '\t' ? false : '"',
        relax_quotes: delimiter !== '\t',
    });

    const seen = new Set();
    const groups = [];

    for (const row of records) {
        const slug = row.group_slug?.trim();
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);

        groups.push({
            slug,
            name: row.group_name ?? '',
            oldMembers: row.group_total_members ? parseInt(row.group_total_members, 10) : null,
            oldMonthlyPriceCents: row.group_monthly_price ? parseInt(row.group_monthly_price, 10) : null,
            oldAnnualPriceCents: row.group_annual_price ? parseInt(row.group_annual_price, 10) : null,
            oldCurrency: row.group_monthly_currency ?? 'usd',
            oldDataDate: row.group_updated_date ?? '',
        });
    }

    return groups;
}

// ─── Main ───────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};

const {
    csvUrl,
    csvContent,
    groupSlugs,
    requestDelayMs = 1500,
    maxConcurrency = 2,
    maxGroups = 0,
    proxyConfiguration: proxyConfig,
    notifyOnPriceChange = true,
} = input;

// ── 1. Resolve groups list ───────────────────────────────────────────────────

let groups = [];

if (Array.isArray(groupSlugs) && groupSlugs.length > 0) {
    // Direct slug list — no CSV needed
    log.info(`Using ${groupSlugs.length} slugs from input.groupSlugs`);
    groups = groupSlugs.map((slug) => ({
        slug,
        name: '',
        oldMembers: null,
        oldMonthlyPriceCents: null,
        oldAnnualPriceCents: null,
        oldCurrency: 'usd',
        oldDataDate: '',
    }));
} else if (csvContent) {
    log.info('Parsing CSV from input.csvContent');
    groups = parseGroupsFromCsv(csvContent);
} else if (csvUrl) {
    log.info(`Fetching CSV from URL: ${csvUrl}`);
    const resp = await fetch(csvUrl);
    if (!resp.ok) throw new Error(`CSV fetch failed: ${resp.status} ${csvUrl}`);
    const text = await resp.text();
    groups = parseGroupsFromCsv(text);
} else {
    log.warning('No input provided (csvUrl, csvContent, or groupSlugs). Nothing to do.');
    await Actor.exit();
}

if (maxGroups > 0) {
    log.info(`Limiting to first ${maxGroups} groups (maxGroups setting)`);
    groups = groups.slice(0, maxGroups);
}

log.info(`Processing ${groups.length} unique Skool groups`);

// ── 2. Build a lookup map: slug → group metadata ─────────────────────────────

const groupMap = Object.fromEntries(groups.map((g) => [g.slug, g]));

// ── 3. Configure proxy ───────────────────────────────────────────────────────

const proxy = proxyConfig
    ? await Actor.createProxyConfiguration(proxyConfig)
    : undefined;

// ── 4. Build request list ────────────────────────────────────────────────────

const requests = groups.map((g) => ({
    url: `https://www.skool.com/${g.slug}/about`,
    label: g.slug,
    userData: { slug: g.slug },
}));

// ── 5. Crawl ─────────────────────────────────────────────────────────────────

let processed = 0;
let priceChanges = 0;

const crawler = new HttpCrawler({
    proxyConfiguration: proxy,
    maxConcurrency,
    minConcurrency: 1,
    requestHandlerTimeoutSecs: 30,

    // Polite delay between requests
    requestHandler: async ({ request, body, response }) => {
        const { slug } = request.userData;
        const meta = groupMap[slug];

        log.info(`[${++processed}/${groups.length}] Fetching ${request.url}`);

        if (response.statusCode === 404) {
            log.warning(`Group not found (404): ${slug}`);
            await Actor.pushData({
                group_slug: slug,
                group_name: meta.name,
                fetch_status: 'not_found',
                skool_url: request.url,
            });
            return;
        }

        const html = body.toString();
        const live = extractSkoolData(html);

        // Calculate diffs
        const membersDiff =
            live.members !== null && meta.oldMembers !== null
                ? live.members - meta.oldMembers
                : null;

        const priceChanged =
            live.monthlyPriceCents !== null &&
            meta.oldMonthlyPriceCents !== null &&
            live.monthlyPriceCents !== meta.oldMonthlyPriceCents;

        if (priceChanged && notifyOnPriceChange) {
            priceChanges++;
            log.warning(
                `💰 PRICE CHANGE — ${slug}: ` +
                `$${centsToDollars(meta.oldMonthlyPriceCents)}/mo → ` +
                `$${centsToDollars(live.monthlyPriceCents)}/mo`
            );
        }

        await Actor.pushData({
            // Identity
            group_slug: slug,
            group_name: meta.name,
            skool_url: request.url,

            // Old data (from CSV)
            old_members: meta.oldMembers,
            old_monthly_price_usd: centsToDollars(meta.oldMonthlyPriceCents),
            old_annual_price_usd: centsToDollars(meta.oldAnnualPriceCents),
            old_currency: meta.oldCurrency,
            old_data_date: meta.oldDataDate,

            // Live data (freshly scraped)
            live_members: live.members,
            live_monthly_price_usd: centsToDollars(live.monthlyPriceCents),
            live_annual_price_usd: centsToDollars(live.annualPriceCents),
            live_currency: live.currency,

            // Diffs
            members_diff: membersDiff,
            members_diff_pct:
                membersDiff !== null && meta.oldMembers
                    ? parseFloat(((membersDiff / meta.oldMembers) * 100).toFixed(1))
                    : null,
            price_changed: priceChanged,

            // Meta
            fetch_status: live.source ?? 'ok',
            scraped_at: new Date().toISOString(),
        });

        // Polite delay
        await new Promise((r) => setTimeout(r, requestDelayMs));
    },

    failedRequestHandler: async ({ request, error }) => {
        const { slug } = request.userData;
        log.error(`Failed: ${slug} — ${error.message}`);
        await Actor.pushData({
            group_slug: slug,
            group_name: groupMap[slug]?.name ?? '',
            fetch_status: `error: ${error.message}`,
            skool_url: request.url,
            scraped_at: new Date().toISOString(),
        });
    },
});

await crawler.run(requests);

// ── 6. Summary ───────────────────────────────────────────────────────────────

log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
log.info(`✅  Done! Processed ${processed} groups.`);
if (priceChanges > 0) {
    log.warning(`💰  ${priceChanges} group(s) have changed pricing.`);
}
log.info('📊  Results saved to dataset — export as CSV/JSON from Apify console.');
log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

await Actor.exit();
