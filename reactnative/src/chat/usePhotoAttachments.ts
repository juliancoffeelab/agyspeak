import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import { MAX_PHOTOS, MAX_PHOTO_BYTES } from "./openRouter";
import type { PhotoInput } from "./history";
import type { PersistentDraft } from "./PersistentDraft";

function removeFile(uri: string) {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* Cache cleanup can retry when the OS reclaims it. */
  }
}

export function usePhotoAttachments(visible: boolean, draft: PersistentDraft) {
  const photos = useSyncExternalStore(draft.subscribe, draft.getPhotos);
  const [picking, setPicking] = useState(false);
  const ownedRef = useRef(new Set<string>());
  const activeRef = useRef(false);
  const mountedRef = useRef(false);
  const lockedRef = useRef(false);
  useEffect(() => {
    activeRef.current = visible;
    return () => {
      activeRef.current = false;
    };
  }, [visible]);
  useEffect(() => {
    mountedRef.current = true;
    const files = ownedRef.current;
    return () => {
      mountedRef.current = false;
      for (const uri of files) removeFile(uri);
      files.clear();
    };
  }, []);

  function release(uri: string) {
    ownedRef.current.delete(uri);
    removeFile(uri);
  }
  async function normalize(
    asset: Pick<ImagePicker.ImagePickerAsset, "uri" | "width" | "height">,
  ): Promise<PhotoInput> {
    const context = ImageManipulator.manipulate(asset.uri, {
      maxWidth: 2048,
      maxHeight: 2048,
    });
    // Preserve aspect ratio and avoid upscaling; JPEG normalizes HEIC and orientation.
    if (Math.max(asset.width, asset.height) > 2048)
      context.resize(
        asset.width >= asset.height ? { width: 2048 } : { height: 2048 },
      );
    const image = await context.renderAsync();
    let uri: string | undefined;
    try {
      const full = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: 0.85,
      });
      uri = full.uri;
      ownedRef.current.add(uri);
      if (new File(uri).size > MAX_PHOTO_BYTES)
        throw new Error("Choose a smaller photo (under 8 MB).");
      const thumbContext = ImageManipulator.manipulate(image);
      thumbContext.resize(
        full.width >= full.height ? { width: 240 } : { height: 240 },
      );
      const thumbImage = await thumbContext.renderAsync();
      try {
        const thumbnail = await thumbImage.saveAsync({
          format: SaveFormat.JPEG,
          compress: 0.7,
          base64: true,
        });
        removeFile(thumbnail.uri);
        if (!thumbnail.base64)
          throw new Error("Couldn’t create a photo preview.");
        return {
          data: await new File(uri).base64(),
          width: full.width,
          height: full.height,
          thumbnail: thumbnail.base64,
        };
      } finally {
        thumbImage.release();
        thumbContext.release();
      }
    } catch (cause) {
      if (uri) release(uri);
      throw cause;
    } finally {
      if (uri) release(uri);
      image.release();
      context.release();
    }
  }
  async function pick(source: "camera" | "photos") {
    if (lockedRef.current || !activeRef.current) return;
    if (photos.length >= MAX_PHOTOS)
      throw new Error("You can attach up to four photos. Remove one first.");
    lockedRef.current = true;
    setPicking(true);
    const added: PhotoInput[] = [];
    try {
      if (source === "camera") {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted)
          throw new Error(
            "Allow camera access to take a photo. You can change this in your device settings.",
          );
        if (!activeRef.current) return;
      }
      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync({
              mediaTypes: ["images"],
              quality: 1,
            })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ["images"],
              allowsMultipleSelection: true,
              selectionLimit: MAX_PHOTOS - photos.length,
              quality: 1,
            });
      if (result.canceled || !activeRef.current) return;
      for (const asset of result.assets.slice(0, MAX_PHOTOS - photos.length)) {
        added.push(await normalize(asset));
        if (!activeRef.current) return;
      }
      if (
        photos.reduce((sum, photo) => sum + photo.encodedLength, 0) +
          added.reduce((sum, photo) => sum + photo.data.length, 0) >
        Math.ceil(MAX_PHOTO_BYTES / 3) * 4
      )
        throw new Error("Keep photos under 8 MB per message.");
      if (activeRef.current && !draft.suspended) await draft.addPhotos(added);
    } finally {
      lockedRef.current = false;
      if (mountedRef.current) setPicking(false);
    }
  }
  return {
    photos,
    picking,
    pick,
    remove: (id: number) => draft.removePhoto(id),
    read: () => draft.readPhotos(),
    isActive: () => activeRef.current,
  };
}
