import { validatePhotoPayloads } from "../../../providers/openrouter/transport.ts";
import type { PhotoInput } from "../storage/contracts";

// Submitted photos also need the preview data chat stores beside them.
export function validatePhotos(photos: PhotoInput[]) {
  validatePhotoPayloads(photos);
  for (const photo of photos)
    if (
      !photo.thumbnail ||
      !Number.isFinite(photo.width) ||
      !Number.isFinite(photo.height) ||
      photo.width <= 0 ||
      photo.height <= 0
    )
      throw new Error("Couldn’t read that photo. Choose it again.");
}
