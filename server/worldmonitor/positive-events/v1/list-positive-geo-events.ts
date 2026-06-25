import type {
  ServerContext,
  ListPositiveGeoEventsRequest,
  ListPositiveGeoEventsResponse,
} from '../../../../src/generated/server/worldmonitor/positive_events/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const CACHE_KEY = 'positive-events:geo:v1';

export async function listPositiveGeoEvents(
  _ctx: ServerContext,
  _req: ListPositiveGeoEventsRequest,
): Promise<ListPositiveGeoEventsResponse> {
  try {
    const cached = await getCachedJson(CACHE_KEY, true) as ListPositiveGeoEventsResponse | null;
    return cached ?? { events: [] };
  } catch {
    return { events: [] };
  }
}
