import { File } from "expo-file-system";

// Deletes a temporary file this app made. A file that is already gone or
// can't be deleted is left for the system to reclaim with the cache.
export function removeFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* Cache cleanup is best effort. */
  }
}
