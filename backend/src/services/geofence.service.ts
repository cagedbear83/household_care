const EARTH_RADIUS_METERS = 6_371_000;

/** Great-circle distance in meters between two lat/lng points (haversine). */
export function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GeofenceCheckInput {
  lat: number;
  lng: number;
  accuracyMeters: number | null | undefined;
  apartmentLat: number;
  apartmentLng: number;
  radiusMeters: number;
}

export type VerificationResult = "VERIFIED" | "UNVERIFIED" | "FAILED";

// A fix with no accuracy, or an accuracy wide enough that the true position
// could plausibly fall outside the geofence even though the reported point is
// inside it, must not be silently accepted as verified.
const MAX_ACCEPTABLE_ACCURACY_METERS = 100;

export function evaluateGeofence(input: GeofenceCheckInput): { verification: VerificationResult; distanceMeters: number } {
  const distance = distanceMeters(input.lat, input.lng, input.apartmentLat, input.apartmentLng);
  const accuracy = input.accuracyMeters ?? null;

  if (accuracy === null || accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
    return { verification: "UNVERIFIED", distanceMeters: distance };
  }

  const effectiveRadius = input.radiusMeters + accuracy;
  if (distance <= effectiveRadius) {
    return { verification: "VERIFIED", distanceMeters: distance };
  }

  return { verification: "FAILED", distanceMeters: distance };
}
