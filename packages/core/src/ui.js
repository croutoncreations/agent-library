// Browser shell assets. The files under web/ are served verbatim except for three build-free placeholders in app.js.
import APP_HTML from "./web/app.html.txt";
import APP_CSS from "./web/app.css.txt";
import APP_JS_TEMPLATE from "./web/app.js.txt";
import { EDITOR_JS_SHA256 } from "./editor-bundle.js";
import { HOME_JS } from "./home.js";
import { FRAME_SANDBOX } from "./html.js";

const fill = (template, name, value) => {
  const parts = template.split(name);
  if (parts.length !== 2) throw new Error("app.js placeholder " + name + " must appear exactly once");
  return parts[0] + value + parts[1];
};
const APP_JS = fill(fill(fill(APP_JS_TEMPLATE, "__AL_EDITOR_HASH16__", EDITOR_JS_SHA256.slice(0, 16)), "__AL_FRAME_SANDBOX__", JSON.stringify(FRAME_SANDBOX)), "/*__AL_HOME_JS__*/", HOME_JS);

export { APP_CSS, APP_HTML, APP_JS };
