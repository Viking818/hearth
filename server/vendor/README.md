# Third-party code used by the server

## opusscript/

- What: `opusscript` 0.1.1 by abalabahaha (https://github.com/abalabahaha/opusscript): libopus compiled to
  WebAssembly, with a small JavaScript wrapper. It decodes the sound of Telegram voice messages (Opus) and encodes
  the bot's spoken answers into the same form.
- Files: `index.js`, `LICENSE`, `build/opusscript_native_wasm.js`, `build/opusscript_native_wasm.wasm` and
  `build/COPYING.libopus` from the npm package, unchanged. The package's second build (`opusscript_native_nasm.js`,
  the same code without WebAssembly) is left out: Hearth never asks for it.
- `package.json` here is Hearth's own, one line that matters: it marks the folder as CommonJS, so Node loads
  `index.js` the way the package expects.
- Package checked against the npm registry:
  `sha512-mL0fZZOUnXdZ78woRXp18lApwpp0lF5tozJOD1Wut0dgrA9WuQTgSels/CSmFleaAZrJi/nci5KOVtbuxeWoQA==`
- Used by `server/opus.mjs` through an ordinary `require`.

Licenses: the wrapper is MIT (`opusscript/LICENSE`); libopus itself is under the three-clause BSD license of
Xiph.Org, Skype and others (`opusscript/build/COPYING.libopus`).

## Not included here: the natural voice

The natural voice for spoken answers is not part of Hearth's files. When the user presses "Download" in
Settings → Voice, `server/natural-voice.mjs` fetches two archives from the sherpa-onnx project's releases on GitHub
(https://github.com/k2-fsa/sherpa-onnx), at one fixed version, and checks each against the sha256 written in that
file before unpacking: the program `sherpa-onnx-offline-tts` (sherpa-onnx, Apache-2.0, with ONNX Runtime, MIT) and
the voice Supertonic 3 by Supertone (sample code MIT, the voice files under the OpenRAIL-M license). They land in
the data folder (`voice/natural`), never in the program's own folder.
