import { mountMockPage } from "./page";
import { installHarness } from "./harness";
import { parseDemoScene, sceneCaption } from "./scene-mode";
import "./demo.css";

/**
 * The demo document: mock page on the left, the real side panel in a nested
 * iframe on the right, and the harness in between.
 *
 * The panel is a separate document on purpose — the content tools query
 * `document` with no root, so sharing one would let `takeSnapshot` enumerate
 * the panel's own controls.
 */

const pageRoot = document.getElementById("demo-page");
const frame = document.getElementById("demo-panel") as HTMLIFrameElement | null;
const replay = document.getElementById("demo-replay");
const note = document.querySelector<HTMLElement>(".demo-note");
const scene = parseDemoScene(location.search);

if (pageRoot) mountMockPage(pageRoot);
installHarness();
if (frame) frame.src = `./panel.html?scene=${encodeURIComponent(scene)}`;
if (note) note.textContent = sceneCaption(scene);

replay?.addEventListener("click", () => {
  if (pageRoot) mountMockPage(pageRoot);
  // Reloading the frame restarts the scripted run from the first round.
  if (frame) frame.src = frame.src;
});
