// The Hyperliquid adapter's error: the shared VenueError with the venue fixed and a structured detail.
import { VenueError as Base, type VenueErrorCode, type VenueId } from '../../models.ts';

export class VenueError extends Base {
  declare readonly detail: Record<string, unknown>;
  constructor(venue: VenueId, code: VenueErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(code, `${venue}: ${message}`, { venue, detail });
  }
}
