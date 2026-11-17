/**
 * THE switch for which derivatives venues the owner sees in the web app.
 *
 * 2026-11-17 (owner): « Hyperliquid only ». dYdX and edgeX were market data only (their terms exclude Canada) and GMX, although it
 * worked, is no longer wanted. Their code stays in place — screens, mocks, texts, API — and nothing here touches the server:
 * this list only decides what the interface OFFERS (markets, pickers, venue filters, accounts, agent venue choices) and whether
 * the cross-venue views (Compare, Router) exist at all. To bring a venue back, add its id here; with two or more venues the
 * Compare and Router views come back by themselves.
 *
 * What it does NOT hide, on purpose: money that exists. A position, an order or an activity line on another venue is still
 * listed where the wallet lists everything (Home's dashboard, Activity, the unified orders): hiding real exposure would be a lie.
 *
 * No import from the app: App.tsx reads this from the first chunk.
 */
export const SHOWN_VENUES: readonly string[] = ['hyperliquid'];

/** is this venue offered to the owner? */
export const venueShown = (venue: string): boolean => SHOWN_VENUES.includes(venue);
/** the same for an instrument id (`venue:SYMBOL`) */
export const instrumentShown = (id: string): boolean => venueShown(id.slice(0, Math.max(0, id.indexOf(':'))));
/** two venues or more: comparing them, or routing an order between them, means something */
export const MULTI_VENUE = SHOWN_VENUES.length > 1;
/**
 * The `venue` parameter of a markets-hub listing: the owner's own choice when there is one; otherwise the single shown venue, so
 * that the pages and the totals the server computes are those of what is on screen. With several venues shown the listing is not
 * narrowed by the server: the caller keeps the rows of `venueShown` venues.
 */
export const hubVenueParam = (chosen: string): string => chosen || (SHOWN_VENUES.length === 1 ? SHOWN_VENUES[0]! : '');
