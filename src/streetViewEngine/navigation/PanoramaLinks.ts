import { DEFAULT_ESTIMATED_TRANSITION_METERS, haversineDistanceMeters } from '../../utils/geo';
import type { PanoramaMetadata, ValidatedLink } from '../types';
import { getCardinalLabel, normalizeHeading } from './DirectionCalculator';

/**
 * Extracts, validates, and deduplicates connected neighbouring panorama links
 * from a panorama's official metadata. Never invents links or coordinates.
 */
export function extractValidLinks(
  metadata: PanoramaMetadata,
  knownNodes?: ReadonlyMap<string, PanoramaMetadata>,
): ValidatedLink[] {
  const seen = new Set<string>();
  const links: ValidatedLink[] = [];

  for (const raw of metadata.links || []) {
    const destId = (raw.panoId || '').trim();
    if (!destId || destId === metadata.panoId || seen.has(destId)) {
      continue;
    }
    seen.add(destId);

    const heading = normalizeHeading(raw.heading);
    const destMeta = knownNodes?.get(destId);
    let distanceMeters = DEFAULT_ESTIMATED_TRANSITION_METERS;
    let distanceEstimated = true;

    if (destMeta) {
      const measured = haversineDistanceMeters(
        metadata.lat,
        metadata.lng,
        destMeta.lat,
        destMeta.lng,
      );
      if (Number.isFinite(measured) && measured > 1) {
        distanceMeters = measured;
        distanceEstimated = false;
      }
    }

    links.push({
      sourcePanoId: metadata.panoId,
      destinationPanoId: destId,
      heading,
      text: (raw.text || '').trim() || `Road ${getCardinalLabel(heading)}`,
      distanceMeters,
      distanceEstimated,
    });
  }

  return links;
}
