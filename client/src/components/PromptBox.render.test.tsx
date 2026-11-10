import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptBox, saveDraftAttachments, type PromptAttachment } from "./PromptBox";
import { noImageNote } from "../lib/images";

const image: PromptAttachment = { id: "i1", label: "Image", detail: "", text: "", image: "data:image/png;base64,AAAA" };
const chip: PromptAttachment = { id: "a1", label: "Annotation 1", detail: "h1 — Bigger.", text: "x" };

function box(key: string, imageNote: string | null): string {
  return renderToStaticMarkup(
    <PromptBox
      draftKey={key}
      imageNote={imageNote}
      running={false}
      disabled={false}
      commands={[]}
      onRequestCommands={() => undefined}
      onSubmit={() => true}
      onInterrupt={() => undefined}
    />,
  );
}

describe("an image for a model with no image input", () => {
  const note = noImageNote("glm-5.3-flash");

  it("shows a note under the thumbnail", () => {
    saveDraftAttachments("s1", [image]);
    const html = box("s1", note);
    expect(html).toContain("prompt-attachment-thumb");
    expect(html).toContain('role="note"');
    expect(html).toContain("glm-5.3-flash cannot read images. The agent gets a note in place of each image.");
  });

  it("shows no note with no image, or for a model that reads images", () => {
    saveDraftAttachments("s2", [chip]);
    expect(box("s2", note)).not.toContain('role="note"');
    saveDraftAttachments("s3", [image]);
    expect(box("s3", null)).not.toContain('role="note"');
  });
});
