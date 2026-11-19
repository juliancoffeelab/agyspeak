import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File } from "expo-file-system";
import {
  encodedLength,
  megabytes,
  MAX_PHOTOS,
  MAX_PHOTO_BYTES,
} from "../../providers/openrouter/transport";
import type { CameraCapturedPicture } from "expo-camera";
import type { PhotoInput } from "./storage/contracts";
import type { PersistentDraft } from "./runtime/PersistentDraft";
import { removeFile } from "../../device/files";

export function usePhotoAttachments(active: boolean, draft: PersistentDraft) {
  const photos = useSyncExternalStore(draft.subscribe, draft.getPhotos);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const ownedRef = useRef(new Set<string>());
  const activeRef = useRef(false);
  const mountedRef = useRef(false);
  const lockedRef = useRef(false);
  useEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);
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
        throw new Error(
          `Choose a smaller photo (under ${megabytes(MAX_PHOTO_BYTES)}).`,
        );
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
    } finally {
      if (uri) release(uri);
      image.release();
      context.release();
    }
  }
  async function pick(source: "camera" | "photos") {
    if (lockedRef.current || !activeRef.current) return;
    if (photos.length >= MAX_PHOTOS)
      throw new Error(
        `You can attach up to ${MAX_PHOTOS} photos. Remove one first.`,
      );
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
        setCameraOpen(true);
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
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
        encodedLength(MAX_PHOTO_BYTES)
      )
        throw new Error(
          `Keep photos under ${megabytes(MAX_PHOTO_BYTES)} per message.`,
        );
      if (activeRef.current && !draft.suspended) await draft.addPhotos(added);
    } finally {
      lockedRef.current = false;
      if (mountedRef.current) setPicking(false);
    }
  }
  async function attachCamera(photo: CameraCapturedPicture) {
    if (!activeRef.current || draft.suspended)
      throw new Error("Return to the chat to attach your photo.");
    const input = await normalize(photo);
    if (!activeRef.current || draft.suspended)
      throw new Error("Return to the chat to attach your photo.");
    await draft.addPhotos([input]);
  }
  return {
    cameraOpen,
    closeCamera: () => setCameraOpen(false),
    attachCamera,
    photos,
    picking,
    pick,
    remove: (id: number) => draft.removePhoto(id),
    read: () => draft.readPhotos(),
    isActive: () => activeRef.current,
  };
}
