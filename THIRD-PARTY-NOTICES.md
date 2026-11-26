# Third-party software and files

Hearth's own code is under the MIT license (see `LICENSE`). It includes, or downloads at your request, the work of
others. Thank you to all of them.

## Included in this repository

| What | Where | License |
| --- | --- | --- |
| [Preact](https://preactjs.com) and [htm](https://github.com/developit/htm) | `public/vendor/preact-htm.js` | MIT |
| [PDF.js](https://mozilla.github.io/pdf.js/) 6.4.299 (Mozilla) | `public/vendor/pdfjs/` | Apache-2.0 (`public/vendor/pdfjs/LICENSE`) |
| [html2canvas](https://html2canvas.hertzen.com) 1.4.1 (Niklas von Hertzen) | `public/vendor/html2canvas/` | MIT (`public/vendor/html2canvas/LICENSE`) |
| QR Code Generator for JavaScript (Kazuhiko Arase) | `public/vendor/qrcode/qrcode.mjs` | MIT |
| [Inter](https://rsms.me/inter/) typeface | `public/vendor/fonts/` | SIL Open Font License 1.1 |
| [Lucide](https://lucide.dev) icons | drawn in `public/js/icons.js` | ISC |
| [opusscript](https://github.com/abalabahaha/opusscript) 0.1.1, with libopus compiled to WebAssembly | `server/vendor/opusscript/` | MIT (wrapper), BSD 3-Clause (libopus; `server/vendor/opusscript/build/COPYING.libopus`) |
| Logos of services in the connector directory | `public/brands/` | Simple Icons (CC0 1.0) and each service's own site icon. The logos and names are trademarks of their owners; Hearth only uses them to name the service and is not affiliated with or endorsed by them (`public/brands/README.md`). |

## Inside the ready-made packages

The Windows installer, the Windows zip and the Mac app carry [Node.js](https://nodejs.org) (MIT, with the licenses of
the libraries inside it; the file `LICENSE` lies next to `node.exe`). The Windows installer is made with
[NSIS](https://nsis.sourceforge.io) (zlib/libpng license).

## Downloaded only when you ask for it

Hearth ships no AI model and no AI engine. When you press a Download button, it fetches them from their makers, and
each comes under its own license, which you accept by using it:

- **Chat engine:** [llama.cpp](https://github.com/ggml-org/llama.cpp) (MIT), from its GitHub releases; for AMD Radeon
  cards also AMD's [Lemonade](https://github.com/lemonade-sdk/llamacpp-rocm) builds of it.
- **Second chat engine (optional):** [Colibri](https://github.com/JustVugg/colibri) (Apache-2.0); on Windows with
  python.org's embeddable Python (PSF license) for its launcher.
- **Pictures and videos:** [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (MIT).
- **Voice input:** [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and OpenAI's Whisper model (MIT).
- **Natural voice:** [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0) with ONNX Runtime (MIT), and
  the voice Supertonic 3 by Supertone (OpenRAIL-M).
- **Models:** from Hugging Face, each under the license its page states (Apache-2.0, MIT, the Gemma terms, the LTX-2
  Community License and others). Read a model's page before you use it for business.

Hearth can also start a browser that is already on your computer (Edge, Chrome, Brave) to read pages built by
scripts. It does not include or download a browser.
