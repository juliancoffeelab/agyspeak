import type { RouterModel } from "./routerMetadata";

// A missing catalog entry is unknown, not evidence that audio is supported.
export function audioInputIssue(
  modelId: string,
  models: RouterModel[] | undefined,
): string | null {
  const model = models?.find((item) => item.id === modelId);
  if (!model)
    return `Couldn’t verify audio support for ${modelId}. Refresh the model list in Settings.`;
  return model.audio
    ? null
    : `${model.name} doesn’t support audio input. Choose an audio-capable model in Settings.`;
}

export function imageInputIssue(
  modelId: string,
  models: RouterModel[] | undefined,
): string | null {
  const model = models?.find((item) => item.id === modelId);
  if (!model)
    return `Couldn’t verify photo support for ${modelId}. Refresh the model list in Settings.`;
  return model.image
    ? null
    : `${model.name} doesn’t support image input. Choose an image-capable model in Settings.`;
}
