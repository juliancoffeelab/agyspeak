import assert from "node:assert/strict";
import test from "node:test";
import {
  cameraPictureSize,
  shouldDismissPhoto,
} from "../src/chat/photoInteraction.ts";

test("camera selects near-attachment resolution instead of full sensor size", () => {
  assert.equal(
    cameraPictureSize(["8000x6000", "4000x3000", "2048x1536", "1280x960"]),
    "2048x1536",
  );
  assert.equal(cameraPictureSize(["6000x8000", "1536x2048"]), "1536x2048");
  assert.equal(cameraPictureSize(["640x480", "1280x960"]), "1280x960");
  assert.equal(
    cameraPictureSize(["0x3", "invalid", "Infinityx123"]),
    undefined,
  );
});
test("viewer dismisses on deliberate distance or a downward flick; short and upward gestures snap back", () => {
  assert.equal(shouldDismissPhoto(160, 0, 900), true);
  assert.equal(shouldDismissPhoto(40, 1.2, 900), true);
  assert.equal(shouldDismissPhoto(40, 0.1, 900), false);
  assert.equal(shouldDismissPhoto(10, 2, 900), false);
  assert.equal(shouldDismissPhoto(-160, -2, 900), false);
  assert.equal(shouldDismissPhoto(80, 0, 400), true);
});
