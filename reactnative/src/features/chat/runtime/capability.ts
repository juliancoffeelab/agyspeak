import type { RouterModel } from "../../../providers/openrouter/metadata";
import { selectContext, type ContextEntry } from "./context.ts";

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

// What is about to be added to the stored messages: words with any photos,
// a recording, or nothing when a reply is asked for again.
export type Outgoing =
  | { kind: "text"; text: string; photos: NonNullable<ContextEntry["photos"]> }
  | { kind: "audio" }
  | null;

// Why the model can't take this conversation, or null. `issues` is what the
// model lacks; an input counts only while it is still in the context that
// would be sent.
export function inputIssue(
  messages: ContextEntry[],
  outgoing: Outgoing,
  issues: { audio: string | null; image: string | null },
): string | null {
  if (issues.audio === null && issues.image === null) return null;
  const text = outgoing?.kind === "text" ? outgoing.text.trim() : "";
  const photos = outgoing?.kind === "text" ? outgoing.photos : [];
  const context = selectContext(
    text || photos.length
      ? [...messages, { role: "user", text, photos, status: "complete" }]
      : messages,
  );
  const audio =
    outgoing?.kind === "audio" || context.some((message) => message.audio);
  const image =
    photos.length > 0 || context.some((message) => message.photos?.length);
  return (audio ? issues.audio : null) ?? (image ? issues.image : null);
}
