/**
 * Skool Group Validator — Apify Actor
 *
 * Reads a Skool CSV/TSV export, fetches live data from each group's /about page,
 * and pushes a comparison dataset (old vs. live members + pricing).
 */

import { Actor } from 'apify';
import { HttpCrawler, log } from 'crawlee';

// ─── TSV Parser ──────────────────────────────────────────────────────────────

/**
 * Robust TSV parser that extracts only the columns we care about.
 * Handles multiline fields (group_info/group_description contain newlines)
 * by identifying row boundaries via the UUID pattern in group_id (col 0).
 */
function parseTsvGroups(text) {
    const lines = text.split('\n');
    if (lines.length < 2) return [];

    // Parse header to find column indices
    const headers = lines[0].split('\t').map((h) => h.trim().replace(/^"|"$/g, ''));
    const idx = (name) => headers.indexOf(name);

    const COL = {
        group_id:              idx('group_id'),
        group_slug:            idx('group_slug'),
        group_name:            idx('group_name'),
        group_total_members:   idx('group_total_members'),
        group_monthly_currency:idx('group_monthly_currency'),
        group_monthly_price:   idx('group_monthly_price'),
        group_annual_price:    idx('group_annual_price'),
        group_updated_date:    idx('group_updated_date'),
    };

    log.info(`Column indices: ${JSON.stringify(COL)}`);

    // Each valid data row starts with a 32-char hex UUID in col 0
    const UUID_RE = /^[a-f0-9]{32}\t/;

    const seen = new Set();
    const groups = [];

    for (const line of lines.slice(1)) {
        if (!UUID_RE.test(line)) continue; // skip continuation/header lines

        const cols = line.split('\t');

        const slug = cols[COL.group_slug]?.trim().replace(/^"|"$/g, '');
        if (!slug || seen.has(slug)) continue;

        // Validate slug looks like a real slug (not a number or UUID)
        if (/^\d+$/.test(slug) || /^[a-f0-9]{32}$/.test(slug)) continue;

        seen.add(slug);

        const raw = (i) => cols[i]?.trim().replace(/^"|"$/g, '') ?? '';

        groups.push({
            slug,
            name:                raw(COL.group_name),
            oldMembers:          raw(COL.group_total_members) ? parseInt(raw(COL.group_total_members), 10) : null,
            oldMonthlyPriceCents:raw(COL.group_monthly_price) ? parseInt(raw(COL.group_monthly_price), 10) : null,
            oldAnnualPriceCents: raw(COL.group_annual_price)  ? parseInt(raw(COL.group_annual_price), 10)  : null,
            oldCurrency:         raw(COL.group_monthly_currency) || 'usd',
            oldDataDate:         raw(COL.group_updated_date),
        });
    }

    log.info(`Parsed ${groups.length} valid groups from TSV`);
    return groups;
}

// ─── Skool Data Extractor ────────────────────────────────────────────────────

/**
 * Recursively searches an object for a key, returns first match found.
 */
function deepFind(obj, key, _depth = 0) {
    if (_depth > 10 || obj === null || typeof obj !== 'object') return undefined;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
        const found = deepFind(v, key, _depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

/**
 * Finds the object that CONTAINS the given key (returns parent object).
 */
function deepFindParent(obj, key, _depth = 0) {
    if (_depth > 10 || obj === null || typeof obj !== 'object') return undefined;
    if (key in obj) return obj;
    for (const v of Object.values(obj)) {
        const found = deepFindParent(v, key, _depth + 1);
        if (found !== undefined) return found;
    }
    return undefined;
}

/**
 * Extracts member count and pricing from a Skool /about page HTML.
 *
 * Strategy 1: Parse __NEXT_DATA__ JSON and recursively search for the keys.
 * Strategy 2: Regex directly on the raw HTML (fallback).
 */
function extractSkoolData(html, slug) {
    const result = { members: null, monthlyPriceCents: null, annualPriceCents: null, currency: 'usd' };

    // ── Strategy 1: __NEXT_DATA__ ────────────────────────────────────────────
    const nextDataMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
    );

    if (nextDataMatch) {
        try {
            const nextData = JSON.parse(nextDataMatch[1]);

            // Recursively find these keys anywhere in the object tree
            const memberCount    = deepFind(nextData, 'memberCount')
                                ?? deepFind(nextData, 'totalMembers')
                                ?? deepFind(nextData, 'numMembers');

            // Find the object that holds memberCount — pricing keys are siblings
            const groupObj = deepFindParent(nextData, 'memberCount')
                          ?? deepFindParent(nextData, 'totalMembers');

            if (groupObj) {
                // Log ALL keys in this object so we can see the exact price key name
                const allKeys = Object.keys(groupObj);
                log.info(`[${slug}] Group object keys: ${allKeys.join(', ')}`);

                // Try every plausible price key
                const monthlyPrice =
                    groupObj.monthlyPrice     ??
                    groupObj.priceMonthly     ??
                    groupObj.price            ??
                    groupObj.subscriptionPrice??
                    groupObj.membershipPrice  ??
                    groupObj.monthly_price    ??
                    groupObj.amount           ??
                    groupObj.pricePerMonth    ??
                    groupObj.priceCents       ??
                    null;

                const annualPrice =
                    groupObj.annualPrice      ??
                    groupObj.priceAnnual      ??
                    groupObj.yearly_price     ??
                    groupObj.annual_price     ??
                    groupObj.yearlyPrice      ??
                    null;

                const currency =
                    groupObj.currency         ??
                    groupObj.monthlyPriceCurrency ??
                    'usd';

                log.info(`[${slug}] members:${memberCount} monthlyPrice:${monthlyPrice} annualPrice:${annualPrice}`);

                return {
                    members:           memberCount  ?? null,
                    monthlyPriceCents: monthlyPrice,
                    annualPriceCents:  annualPrice,
                    currency,
                    source: 'next_data',
                };
            }

            // Log top-level pageProps keys for debugging
            const ppKeys = Object.keys(nextData?.props?.pageProps ?? {});
            log.warning(`[${slug}] __NEXT_DATA__ found but no member/price data. pageProps keys: ${ppKeys.join(', ')}`);

        } catch (e) {
            log.warning(`[${slug}] __NEXT_DATA__ parse error: ${e.message}`);
        }
    } else {
        log.warning(`[${slug}] No __NEXT_DATA__ script tag found in HTML`);
    }

    // ── Strategy 2: Raw HTML regex ───────────────────────────────────────────
    const mCount  = html.match(/"memberCount"\s*:\s*(\d+)/)
                 ?? html.match(/"totalMembers"\s*:\s*(\d+)/);

    if (mCount) {
        result.members = parseInt(mCount[1], 10);

        // Log ~600 chars around memberCount to reveal nearby price keys (first group only)
        const pos = html.indexOf(mCount[0]);
        const ctx = html.slice(Math.max(0, pos - 50), pos + 550)
                        .replace(/\s+/g, ' ');
        log.info(`[${slug}] HTML context around memberCount: ${ctx}`);
    }

    // Try every plausible price key in raw HTML
    const pricePatterns = [
        /"monthlyPrice"\s*:\s*(\d+)/,
        /"priceMonthly"\s*:\s*(\d+)/,
        /"price"\s*:\s*(\d+)/,
        /"priceCents"\s*:\s*(\d+)/,
        /"subscriptionPrice"\s*:\s*(\d+)/,
        /"membershipPrice"\s*:\s*(\d+)/,
        /"amount"\s*:\s*(\d+)/,
        /"pricePerMonth"\s*:\s*(\d+)/,
        /"monthly_price"\s*:\s*(\d+)/,
    ];
    const annualPatterns = [
        /"annualPrice"\s*:\s*(\d+)/,
        /"priceAnnual"\s*:\s*(\d+)/,
        /"yearlyPrice"\s*:\s*(\d+)/,
        /"annual_price"\s*:\s*(\d+)/,
    ];

    for (const re of pricePatterns) {
        const m = html.match(re);
        if (m) { result.monthlyPriceCents = parseInt(m[1], 10); break; }
    }
    for (const re of annualPatterns) {
        const m = html.match(re);
        if (m) { result.annualPriceCents = parseInt(m[1], 10); break; }
    }

    log.info(`[${slug}] Regex — members:${result.members} monthly:${result.monthlyPriceCents} annual:${result.annualPriceCents}`);

    return { ...result, source: result.members !== null ? 'regex' : 'not_extracted' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function centsToDollars(cents) {
    if (!cents) return null;
    return parseFloat((Number(cents) / 100).toFixed(2));
}

// ─── Main ────────────────────────────────────────────────────────────────────

await Actor.init();

const input = await Actor.getInput() ?? {};
const {
    csvUrl,
    csvContent,
    groupSlugs,
    requestDelayMs     = 1500,
    maxConcurrency     = 2,
    maxGroups          = 0,
    proxyConfiguration: proxyConfig,
    notifyOnPriceChange = true,
} = input;

// ── 1. Resolve group list ────────────────────────────────────────────────────

let groups = [];

if (Array.isArray(groupSlugs) && groupSlugs.length > 0) {
    log.info(`Using ${groupSlugs.length} slugs from input.groupSlugs`);
    groups = groupSlugs.map((slug) => ({
        slug, name: '', oldMembers: null,
        oldMonthlyPriceCents: null, oldAnnualPriceCents: null,
        oldCurrency: 'usd', oldDataDate: '',
    }));
} else if (csvContent) {
    log.info('Parsing TSV from input.csvContent');
    groups = parseTsvGroups(csvContent);
} else if (csvUrl) {
    log.info(`Fetching TSV from URL: ${csvUrl}`);
    const resp = await fetch(csvUrl);
    if (!resp.ok) throw new Error(`Fetch failed: ${resp.status} ${csvUrl}`);
    groups = parseTsvGroups(await resp.text());
} else {
    log.warning('No input provided. Pass csvContent, csvUrl, or groupSlugs.');
    await Actor.exit();
}

if (maxGroups > 0) groups = groups.slice(0, maxGroups);
log.info(`Processing ${groups.length} groups`);

const groupMap = Object.fromEntries(groups.map((g) => [g.slug, g]));

// ── 2. Proxy ─────────────────────────────────────────────────────────────────

const proxy = proxyConfig ? await Actor.createProxyConfiguration(proxyConfig) : undefined;

// ── 3. Crawl ─────────────────────────────────────────────────────────────────

let processed = 0;
let priceChanges = 0;

const crawler = new HttpCrawler({
    proxyConfiguration: proxy,
    maxConcurrency,
    minConcurrency: 1,
    requestHandlerTimeoutSecs: 30,

    requestHandler: async ({ request, body, response }) => {
        const { slug } = request.userData;
        const meta = groupMap[slug];
        log.info(`[${++processed}/${groups.length}] ${slug} — HTTP ${response.statusCode}`);

        if (response.statusCode === 404) {
            await Actor.pushData({ group_slug: slug, group_name: meta.name, fetch_status: 'not_found', skool_url: request.url });
            return;
        }

        const live = extractSkoolData(body.toString(), slug);

        const membersDiff = (live.members !== null && meta.oldMembers !== null)
            ? live.members - meta.oldMembers : null;

        const priceChanged = (live.monthlyPriceCents !== null && meta.oldMonthlyPriceCents !== null)
            && live.monthlyPriceCents !== meta.oldMonthlyPriceCents;

        if (priceChanged && notifyOnPriceChange) {
            priceChanges++;
            log.warning(`💰 PRICE CHANGE ${slug}: $${centsToDollars(meta.oldMonthlyPriceCents)} → $${centsToDollars(live.monthlyPriceCents)}/mo`);
        }

        await Actor.pushData({
            group_slug:             slug,
            group_name:             meta.name,
            skool_url:              request.url,
            old_members:            meta.oldMembers,
            old_monthly_price_usd:  centsToDollars(meta.oldMonthlyPriceCents),
            old_annual_price_usd:   centsToDollars(meta.oldAnnualPriceCents),
            old_data_date:          meta.oldDataDate,
            live_members:           live.members,
            live_monthly_price_usd: centsToDollars(live.monthlyPriceCents),
            live_annual_price_usd:  centsToDollars(live.annualPriceCents),
            members_diff:           membersDiff,
            members_diff_pct:       membersDiff !== null && meta.oldMembers
                                        ? parseFloat(((membersDiff / meta.oldMembers) * 100).toFixed(1)) : null,
            price_changed:          priceChanged,
            fetch_status:           live.source,
            scraped_at:             new Date().toISOString(),
        });

        await new Promise((r) => setTimeout(r, requestDelayMs));
    },

    failedRequestHandler: async ({ request, error }) => {
        const { slug } = request.userData;
        log.error(`Failed ${slug}: ${error.message}`);
        await Actor.pushData({
            group_slug: slug, group_name: groupMap[slug]?.name ?? '',
            fetch_status: `error: ${error.message}`,
            skool_url: request.url, scraped_at: new Date().toISOString(),
        });
    },
});

await crawler.run(groups.map((g) => ({
    url: `https://www.skool.com/${g.slug}/about`,
    userData: { slug: g.slug },
})));

log.info(`Done. ${processed} processed, ${priceChanges} price changes.`);
await Actor.exit();
