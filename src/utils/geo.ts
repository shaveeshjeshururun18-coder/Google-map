import type { StreetViewAddressComponent, TileGridSpec } from '../types/streetview';

const EARTH_RADIUS_METERS = 6_371_000;

export const DEFAULT_ESTIMATED_TRANSITION_METERS = 12;

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function haversineDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return NaN;
  }

  const dLat = degToRad(lat2 - lat1);
  const dLng = degToRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(degToRad(lat1)) *
      Math.cos(degToRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function calculateBearingDegrees(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const phi1 = degToRad(lat1);
  const phi2 = degToRad(lat2);
  const dLambda = degToRad(lng2 - lng1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const theta = radToDeg(Math.atan2(y, x));
  return ((theta % 360) + 360) % 360;
}

export function offsetCoordinates(
  lat: number,
  lng: number,
  distanceMeters: number,
  bearingDegrees: number,
): { lat: number; lng: number } {
  const angularDist = distanceMeters / EARTH_RADIUS_METERS;
  const bearing = degToRad(bearingDegrees);
  const lat1 = degToRad(lat);
  const lng1 = degToRad(lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) +
      Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearing),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDist) * Math.cos(lat1),
      Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: radToDeg(lat2),
    lng: ((radToDeg(lng2) + 540) % 360) - 180,
  };
}

export function formatStreetAndLocation(
  addressComponents?: StreetViewAddressComponent[],
  fallbackLat?: number,
  fallbackLng?: number,
): { streetName: string; formattedLocation: string } {
  if (!addressComponents || addressComponents.length === 0) {
    const coordLabel =
      fallbackLat !== undefined && fallbackLng !== undefined
        ? `${fallbackLat.toFixed(5)}, ${fallbackLng.toFixed(5)}`
        : 'Unknown Street';
    return { streetName: coordLabel, formattedLocation: coordLabel };
  }

  const findByType = (type: string) =>
    addressComponents.find((c) => c.types.includes(type))?.longName;

  const streetNumber = findByType('street_number');
  const route = findByType('route');
  const locality =
    findByType('locality') ||
    findByType('sublocality') ||
    findByType('administrative_area_level_2');
  const adminArea = findByType('administrative_area_level_1');
  const country = findByType('country');

  const streetName = route
    ? streetNumber
      ? `${streetNumber} ${route}`
      : route
    : locality || adminArea || country || 'Unnamed Road';

  const parts = [route, locality, adminArea, country].filter(
    (part, idx, arr): part is string => Boolean(part) && arr.indexOf(part) === idx,
  );

  return {
    streetName,
    formattedLocation: parts.length > 0 ? parts.join(', ') : streetName,
  };
}

export function computeTileGridSpec(
  imageWidth: number,
  imageHeight: number,
  tileWidth: number,
  tileHeight: number,
  requestedZoom: number,
): TileGridSpec {
  const safeTileW = Math.max(1, tileWidth || 512);
  const safeTileH = Math.max(1, tileHeight || 512);
  const safeImgW = Math.max(safeTileW, imageWidth || 13312);
  const safeImgH = Math.max(Math.round(safeTileH / 2), imageHeight || 6656);

  const computedMaxZoom = Math.max(
    0,
    Math.min(5, Math.ceil(Math.log2(safeImgW / safeTileW))),
  );
  const zoom = Math.max(0, Math.min(computedMaxZoom, Math.round(requestedZoom)));
  const scale = Math.pow(2, computedMaxZoom - zoom);

  const levelWidth = Math.max(1, Math.round(safeImgW / scale));
  const levelHeight = Math.max(1, Math.round(safeImgH / scale));
  const tilesX = Math.max(1, Math.ceil(levelWidth / safeTileW));
  const tilesY = Math.max(1, Math.ceil(levelHeight / safeTileH));

  return {
    zoom,
    maxZoom: computedMaxZoom,
    tilesX,
    tilesY,
    tileWidth: safeTileW,
    tileHeight: safeTileH,
    levelWidth,
    levelHeight,
  };
}

export function formatCoordinates(lat: number, lng: number): string {
  const latDir = lat >= 0 ? 'N' : 'S';
  const lngDir = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}° ${latDir}, ${Math.abs(lng).toFixed(5)}° ${lngDir}`;
}
