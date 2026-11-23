import type { RouterModel } from "../../../providers/openrouter/metadata";

// Why a model can't take one kind of input, or null. A missing catalog entry
// is unknown, not evidence that the input is supported.
function supportIssue(
  modelId: string,
  models: RouterModel[] | undefined,
  input: "audio" | "image",
): string | null {
  const model = models?.find((item) => item.id === modelId);
  if (!model)
    return `Couldn’t verify ${input === "audio" ? "audio" : "photo"} support for ${modelId}. Refresh the model list from the model picker.`;
  return model[input]
    ? null
    : `${model.name} doesn’t support ${input} input. Choose an ${input}-capable model for this chat.`;
}
export const audioInputIssue = (
  modelId: string,
  models: RouterModel[] | undefined,
) => supportIssue(modelId, models, "audio");
export const imageInputIssue = (
  modelId: string,
  models: RouterModel[] | undefined,
) => supportIssue(modelId, models, "image");

// What the model lacks that a request may carry: why it can't take audio,
// and why it can't take photos, each null when it takes them.
export type InputIssues = { audio: string | null; image: string | null };

// Why the model can't take this request, which message carries what it
// can't take and of which kind, or null: the provider messages exactly as
// they are sent, after whoever built them applied the summary and the media
// budget.
export function requestIssue(
  messages: readonly { audio?: unknown; photos?: readonly unknown[] }[],
  issues: InputIssues,
): { reason: string; message: number; input: "audio" | "image" } | null {
  const audio = messages.findIndex((message) => message.audio !== undefined);
  if (audio !== -1 && issues.audio !== null)
    return { reason: issues.audio, message: audio, input: "audio" };
  const image = messages.findIndex(
    (message) => (message.photos?.length ?? 0) > 0,
  );
  if (image !== -1 && issues.image !== null)
    return { reason: issues.image, message: image, input: "image" };
  return null;
}
