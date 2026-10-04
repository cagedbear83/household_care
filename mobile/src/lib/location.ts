import * as Location from "expo-location";
import type { Coords } from "./api";

export class LocationUnavailableError extends Error {}

/** Requests foreground permission (if not already granted) and returns a
 * fresh fix. Background/periodic collection while the app is not in the
 * foreground is a separate capability (expo-task-manager +
 * Location.startLocationUpdatesAsync with a foreground-service config) that
 * is intentionally not wired up yet — see IP-App-Specification.md's note
 * that background location needs its own permission/lifecycle handling and
 * must be validated on a real device before being promised to the IP. */
export async function getVerifiedCoords(): Promise<Coords> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") {
    throw new LocationUnavailableError("Location permission was not granted.");
  }

  const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyMeters: position.coords.accuracy ?? null,
  };
}
