# What Hearth can do

The long version. For a quick look, see the [README](../README.md).

## Features

- **Chat** with history, full-text search over every chat, rename, export to Markdown. Edit an earlier question and ask
  again, or start a **branch** from any message (the original chat stays as it was).
  Add **images**, **documents** (PDF, Word, Excel, PowerPoint, OpenDocument; scanned PDFs are read as pictures by models
  that see) and **text files**. Long documents are cut to what the model can keep in mind, with a note.
  The **Think** switch lets the model reason step by step before it answers.
- **Assistants**: ready-made roles (customer replies, product descriptions, translator, social media posts, explain
  simply) and your own, each with its own instructions. **Memory**: facts every chat keeps in mind; with tools on, “remember
  that…” in a chat adds one.
- **Tools** in the chat (each step shows): web search (works without a key; a free Brave or Tavily key, or your own
  SearXNG, makes it steadier), read web pages and PDFs (pages built by scripts are opened with a browser of the
  computer, without a window), read files in folders you allow (never write), remember facts, read skills, and tools from
  **connectors** (MCP servers; Hearth asks before each connector call unless you turn that off).
- **Customize** (connectors, skills, plugins and commands), in Claude's formats so ready-made ones work:
  - **Connector directory**: about 60 well-known services with their logos, in groups (design and media, documents
    and mail, shop and payments, websites, social and marketing, tasks and team, developers), searchable, with the
    ones a small business uses most on top (Canva, Higgsfield, Figma, Notion, Shopify, Fourthwall, Hostinger, Metricool,
    Zapier). **Connect** adds the service and opens its own sign-in page in the browser; most services let Hearth
    register itself. Every entry was connected for real on 2026-11-08: 42 reach their sign-in page, 4 work without an
    account (Shopify, Squarespace, B12, Hugging Face). Hearth copes with the ways services differ: a service that takes
    only `http://localhost` as the way back (Calendly), one that lets a new app ask for less access than it lists or
    answers a bare 403 before the sign-in (Adobe), one whose tools ask for the sign-in inside their answers
    (Fourthwall). Google (Gmail, Calendar, Drive, Docs), Figma, Slack, HubSpot, Asana, Box and Zoom take only apps they
    approved in advance, and Mailchimp's server turns unknown apps away, so they are shown but can't be connected
    directly (Zapier reaches them; Figma's desktop app has a server of its own). A connector in error has **Try again**.
  - **Skills**: folders with a `SKILL.md` (a name, a description that says when to use it, and instructions). The model
    sees the descriptions and reads a skill with the `use_skill` tool when a task fits; type `/name` in a chat to switch
    one on there. Write your own in Hearth, or install them from GitHub (for example `github.com/anthropics/skills`) or a
    `.zip`. Hearth never runs a skill's scripts.
  - **Plugins** (Claude Code's format): skills, commands, agents (they become assistants) and connectors in one package,
    from a GitHub link, a collection ("marketplace", e.g. `github.com/anthropics/claude-plugins-official`) or a `.zip`.
    Hooks are not used. A plugin's connectors stay off until you turn each one on, and keys they need are asked for.
  - **Commands**: saved requests started with `/name` in the chat; `$ARGUMENTS` is what you type after the name.
  - **Connectors**: MCP servers added one by one (a program or an address), or as Claude Desktop's JSON. Services that
    need your account (Notion, Linear, Atlassian, Canva…) get a **Sign in** button: their own sign-in page opens in
    your browser, and connectors with the same address share the sign-in. Services that only accept apps they approved
    in advance (Slack, HubSpot, GitHub…) say so instead, and offer a box to paste an access token where the service
    gives one out (for GitHub, a personal access token). When connectors bring many tools with long instructions
    (Notion: 77 tools, about 78,000 tokens), the model gets their names only and looks one up when it needs it
    (`find_tool`, `use_tool`), so every message stays short on a local model.
- **Bots** (helpers that work on their own, on your own computer): a bot takes a task and does it step by step
  with its tools until it has the result: it searches the web, reads pages, writes and changes files in its own **work
  folder** (`Documents/Hearth Bots/<name>`: texts, Excel tables, web pages), uses skills, connectors and memory if you
  let it. It runs in Hearth, so it goes on with the window closed; bots work one at a time. Each bot has a
  **schedule** ("every day at 09:00", "weekdays at 10:30", "every 3 hours") and can have its own **Telegram** bot:
  make one with @BotFather, paste its token, open the link once so the bot knows you, and write to it from anywhere
  (Hearth fetches the messages itself, so nothing on the computer is opened to the internet). A bot can also answer
  **customers** in Telegram; strangers get no access to your files, folders, connectors or memory. The conversation is
  kept short on purpose (past ~24,000 tokens old tool results are cut, well under the limit and oldest first, and only
  if that is not enough the older part becomes short notes). Cutting rarely and never at the start lets the engine
  reuse what it has read, so on a slow computer a long task reads little more than each new page. Ready-made bots:
  helper, customer replies, morning digest, researcher, product listings.
  A bot reads PDF, Word, Excel and PowerPoint files (a document sent to it in Telegram is read at once) and writes
  Word documents and Excel tables.
- **This computer** (Settings): on Windows, **Start with Windows** puts Hearth in your own startup list (no
  administrator needed): it starts without a window when you sign in, so bots answer and run on schedule again after a
  restart (on a Mac, Hearth's menu has *Open at login*). **Keep the computer awake**: while bots have Telegram or a
  schedule, a bot works, or the model, pictures or videos are busy (the default), always while Hearth runs, or never.
  The screen can still turn off; a small script (`server/keep-awake.ps1`, Windows) or `caffeinate` (Mac) holds it
  only while needed and lets go when Hearth closes.
- **Artifacts**: every page, app, game or SVG picture the chat writes is kept (one per answer, with its versions), in a
  gallery of live previews with search (by the words on the page) and filters. Open one full size, see its code, go
  back to an earlier version, download it, or continue in its chat. **New artifact** starts a chat with a ready brief
  (price calculator, landing page, order form, quiz…). Artifacts always run sandboxed: what the model wrote never runs
  as Hearth itself, even in a window of its own.
- **Design**: posters, social posts (Instagram, Stories/Reels/TikTok, Pinterest, Facebook, YouTube), T-shirt prints
  (4500×5400 px, 300 dpi, transparent), logos, flyers, A3 posters, business cards and banners. Describe it; the model
  lays it out as an exact-size page on a canvas; change it by asking (or with quick buttons) and step through its
  versions; add your own pictures or ones from Pictures; use your **brand kit** (name, slogan, colours, fonts, logo).
  **Save PNG** draws it at print size in the app (html2canvas 1.4.1, MIT, bundled).
- **Voice**: the microphone button turns speech into text on the computer with Whisper (large-v3 turbo, ~100 languages);
  answers can be read aloud with the system's voices. **Voice conversation**: speak, Hearth notices when you have
  finished, answers aloud and listens again. A bot in Telegram understands voice messages and answers them by voice;
  an optional **natural voice** (Supertonic 3, a 151 MB download, 31 languages) replaces the system's robotic one.
- **Batch**: one instruction for up to 2000 photos or files (e.g. title, description and tags for every product photo).
  It runs on the computer, goes on if the window closes, and the table can be edited and saved as Excel or CSV.
- **Pictures**: Z-Image Turbo (open, Apache 2.0) draws on the computer with stable-diffusion.cpp, including text in
  pictures; styles for T-shirt prints, logos, photos and mockups; a gallery; hand a picture over to a chat.
  If the chat model takes the memory pictures need, Hearth offers to stop it while drawing.
- **Video**: LTX-2.5 from Lightricks (LTX-2 Community License: free under $10M yearly revenue) makes clips of 3, 5 or
  10 seconds with sound, from a description or from a picture ("Animate this picture" on the Pictures page), with the
  same stable-diffusion.cpp. The distilled model runs Lightricks' two-stage recipe (8 steps at half size, a 2× latent
  upscale, 3 steps at full size, up to 1280×704). The 26 GB text encoder is shrunk once after download (8 or 4 bits).
- **Live preview**: when the model writes an HTML page, game or SVG, it opens next to the chat and updates while it writes.
- **Models**: hardware check, fit rating for every size, downloads from Hugging Face (resume after a break, cancel),
  search all of Hugging Face, the engine, and **updates** (a newer engine, changed model files; checked daily, never
  installed without asking).
- **Monitor**: what the model is doing, speed, graphics and memory load, context fill, recent requests, the engine log.
- **Connect apps**: a local **OpenAI-compatible** API at `http://127.0.0.1:7420/v1` and an **Anthropic-compatible** API at
  `http://127.0.0.1:7420`, with copy-paste setup for Claude Code, Codex, OpenCode, Python and curl, and a one-click check.
- **Phone and tablet**: turn it on in Settings, scan the QR code, and use the whole app from a phone on the same Wi-Fi.
- **Model settings** (the sliders button next to each model): conversation context,
  drafting (automatic, the model's MTP draft, guesses from the text, or off), computer use (*leave 20% for my work* or
  *full performance*), reading pictures (on the GPU or the processor), and for experts the context memory (F16, INT8,
  INT4), low-RAM mode (experts from the SSD), several models at once and extra engine options. The memory estimate
  follows every change; settings can be saved under a name and applied to other models; **Speed test** loads the model
  with these settings and measures how fast it reads and writes.
- **Several models at once** (Settings → Running models, or in a model's settings): loading another model keeps the
  others; apps choose a model by its name (`/v1/models` lists them), the chat uses the default one.
- **Settings**: language, context size, images, guess-and-check speed-up, parallel slots, memory, tools, voice, phones,
  thinking for apps, extra model folders, Hugging Face token, engine choice and expert options, light/dark theme.

## Using it with Claude Code

Open **Connect apps** and copy the Claude Code block, or run `node bin/hearth.mjs connect`. Tips:

- Use a **64K context** and **thinking off for apps** (one click each on the Connect page).
- Coding tools need a model that is good with tools. Small models (under ~20B) sometimes say they did something without
  doing it. **Qwen3.6 35B A3B** or **Qwen3.8 27B** are good choices on a 48 GB Mac.
- Hearth keeps two engine slots by default, so Claude Code's side requests don't wipe the main conversation's memory.
  Measured on an M3 Max with Gemma 4 12B: a follow-up turn took 1.7 s instead of about 50 s.

## Where things are

| What | Mac | Windows | Linux |
| --- | --- | --- | --- |
| Settings, chats, engines | `~/Library/Application Support/Hearth` | `%LOCALAPPDATA%\Hearth` | `~/.local/share/hearth` |
| Downloaded models | `…/Hearth/models` (change in Settings) | same | same |

Nothing big is stored next to the app, so the app folder can live on an iCloud or OneDrive Desktop.

## Privacy and safety

- Hearth listens on `127.0.0.1` only, so other computers can't reach it. **Connect apps → My network too** opens the API
  (not the app) to your Wi-Fi, and then every request needs the API key.
- **Phones** reach the app only after scanning the QR code shown on the computer; each gets its own cookie, guessing is
  slowed down, and only the computer itself can change who gets in, the allowed folders, connectors or plugins. The Wi-Fi
  connection is plain HTTP, so use it on your own network.
- The app itself can only be controlled from this computer (and paired phones); other websites can't send it commands,
  and the engine has a private key because llama.cpp's server accepts any website by default.
- **Tools**: web pages are fetched only from public addresses (never this computer, the router or a NAS, even through a
  redirect); file tools read only inside the folders you allowed, after resolving links; nothing is ever written or deleted.
  A web page can contain instructions aimed at the model, so connector tools ask first by default.
- **Bots** write only inside their own work folder (checked after resolving links; 5 MB a file, downloads up to 50 MB).
  A bot uses only the tools switched on for it, and connectors without asking once you switch them on for it. Its files
  are downloaded, never shown inside the app, and **Open** only opens documents, never programs. The Telegram token
  stays on the computer and is never shown again; the owner link works once; a bot that answers anyone gives strangers
  the web at most and 30 messages an hour each.
- **Extensions**: install skills and plugins only from sources you trust, because their instructions go to the model.
  Installing copies files only (links inside are skipped, size is capped); nothing from a skill or plugin runs until you
  turn a connector on.
- **Connector sign-ins** (OAuth with PKCE) and pasted tokens are set only on the computer itself. They stay in the data folder
  (`oauth/`, one file per service, readable only by your user), are refreshed before they run out, and go only to the
  service they belong to; the app's page never sees them. **Sign out** deletes them and asks the service to forget them.
- Answers are shown as safe text: model output can't run scripts in the app. Live previews, artifacts and designs run in
  a locked-down frame with no origin; opened in a window of their own they are served with a sandbox policy. Saving a
  design as PNG needs a frame of Hearth's origin, so the design is cleaned first (no scripts, frames or event handlers)
  and a security policy lets only Hearth's own two scripts run in it.

## Big models (more than your memory)

Some models are much bigger than they need to be in memory. Hearth reads each model file's parts and makes a memory plan
before loading it:

- **Lookup tables stay on the SSD.** Qwen3.8-Flash-Next carries a 28.8 GB n-gram table; each word reads one small row of
  it. Hearth tells the engine to read those rows from the SSD (`--lazy-mode on`), so 29 GB of the 66 GB download never
  takes memory. Gemma 4 E2B/E4B have smaller tables that get the same treatment.
- **Spare experts stay in the file.** A mixture-of-experts model uses only a few experts per word (Flash-Next: 10 of 512
  per layer). When the experts don't all fit in the Mac's GPU share, Hearth keeps the experts of a few layers in the model
  file (`--n-cpu-moe N`): macOS holds them in its file cache when it has room and reads them from the SSD when not, and the
  processor works on them while the GPU does the rest. On a PC with a graphics card, llama.cpp's fit step does the same.
- The Models page says what will happen before you download: “Runs well”, “Runs, part from SSD” (with how much), or
  “Too slow here” when too much would come from the SSD for every word.

This needs a recent engine (Models → Engine → Update). Hearth checks that the engine knows a model's architecture
before loading it.

### Colibri, a second engine (experimental)

For big mixture-of-experts models, a model's settings offer **Engine: llama.cpp or Colibri**
([JustVugg/colibri](https://github.com/JustVugg/colibri), Apache 2.0). Colibri places the experts by how often they are
used: the hottest on the graphics card (Vulkan on any card, CUDA on NVIDIA), warm ones in memory, the rest read from the
disk; and it keeps a conversation's state between turns, so an agent's next turn reads only what is new.
Its author measured Qwen3.8-Flash-Next writing about 50 tokens a second on a 24 GB card with 62 GB of RAM.

- **Download** in the model's settings: Hearth fetches Colibri's newest release from GitHub and checks it against the
  release's SHA256SUMS. On Windows it also sets up a private Python for Colibri's launcher (python.org's embeddable
  package, standard library only, pinned by its SHA-256; nothing is installed in the system).
- **The model file stays where it is**: `coli import` writes a small folder that points at the GGUF (config,
  tokenizer, chat template) in Hearth's data folder. Architectures: Qwen3.5/3.6/3.8 (also Flash-Next), DeepSeek V4,
  GLM-5.x, Kimi K3, MiMo, Inkling, OLMoE, LFM3 and the others Colibri lists.
- **Hearth runs it like llama-server**: `coli serve` on a private port with a key only Hearth knows; chats, bots,
  batches and apps (`/v1`) go through Hearth as before. Requests are put in Colibri's dialect: the model name it was
  started with, the thinking switch at the top level (else Qwen3.8 thinks at full depth every time), no token
  penalties. A request waits up to an hour for its turn (Colibri answers one at a time).
- **The speed test** measures Colibri from its stream (it reports counts, not timings) and keeps the last result of
  each engine, so the two can be compared on this computer.
- Not yet: pictures in a chat, `response_format` as a strict rule (batches may need a second try), several
  conversations at once. On a Mac, Colibri runs Qwen3.8 on the processor (its Metal engines are GLM, Inkling and Kimi
  K3), where llama.cpp on Metal is faster.

## How it compares to Strata

Strata has its own engine with hand-written GPU code for Qwen3.8-Flash-Next: an expert cache that adapts to the
conversation, read-ahead of the next layer's experts, and “guess-then-check” decoding with the model's MTP layer. Hearth
uses stock llama.cpp with the memory plan above, so the same big models run, but more slowly than in Strata. Everything
around the engine (app, model manager, monitor, local APIs, app connections) is Hearth's own.

## For developers

```
server/            Node server, no dependencies
  index.mjs          web server, app routes (/api), launcher window
  api.mjs            /v1 OpenAI + Anthropic API: forwards to the engine, adds date, assistant and memory to chats
  engine.mjs         starts/stops llama-server with the chosen model
  speed.mjs          guess-and-check decoding: MTP drafts and guesses from the text
  model-settings.mjs each model's own settings, saved sets of settings
  speedtest.mjs      the speed test
  engine-install.mjs finds llama.cpp or downloads the right official build
  colibri.mjs        Colibri, the second engine: its download, the private Python, linking a GGUF, `coli serve`
  hardware.mjs       chip, memory, graphics cards, live load numbers
  models.mjs         finds GGUF models on disk (Hearth, LM Studio, Ollama, HF cache)
  catalog.mjs        Hugging Face catalog, file sizes, "will it fit"
  plan.mjs           the memory plan for big models
  downloads.mjs      resumable downloads
  gguf.mjs           reads GGUF model headers
  monitor.mjs        live stats and request log
  i18n.mjs           the language of each request
  chats.mjs          chat files and full-text search
  assistants.mjs     assistants and memory
  tools.mjs          the chat's tools; web.mjs (search, pages), mcp.mjs (MCP client, "connectors")
  oauth.mjs          signing in to connectors that are web services (discovery, registration, tokens)
  extensions.mjs     skills, plugins and commands; ext-install.mjs installs them from GitHub, a .zip or a folder
  directory.mjs      the connector directory (Customize → Connectors); logos in public/brands
  artifacts.mjs      artifacts and designs (versions, search, sandboxed pages) and the brand kit; the Design page's
                     brief is public/js/design-prompt.js
  batch.mjs          batch jobs
  bots.mjs           bots, their schedules and tasks; agent.mjs runs a bot's steps (one task at a time, short
                     conversations); workfiles.mjs is its work folder; telegram.mjs its Telegram bot (long polling)
  images.mjs         pictures (stable-diffusion.cpp)
  videos.mjs         videos with sound (LTX-2.5 through stable-diffusion.cpp)
  voice.mjs          speech to text (whisper.cpp)
  power.mjs          this computer: starting with Windows, keeping it awake (keep-awake.ps1 on Windows)
  updates.mjs        engine and model update checks
  phone.mjs          pairing phones and tablets
public/            the app (Preact + htm, no build step); js/lang/ru.js holds the Russian words
mac/               Hearth.app: Swift window + menu bar icon; build.sh bundles Node.js
windows/           package.sh makes Hearth-Windows-<version>.zip with Node.js inside, and Hearth-Setup-<version>.exe from installer.nsi
                   (needs NSIS: brew install makensis)
scripts/           i18n-keys.mjs lists texts missing from a language file
tests/             npm test
```

Run tests with `npm test`. Use a separate data folder and port for experiments:
`HEARTH_DATA_DIR=/tmp/hearth-dev node server/index.mjs --port 7480`.
A new language is one file in `public/js/lang/` plus a line in `public/js/i18n.js`; `node scripts/i18n-keys.mjs xx`
lists what is missing.

Hearth runs every day on a Windows PC with an AMD Radeon card (Vulkan) as well as on a Mac. Not done yet: a Developer
ID signature so the Mac app opens on other Macs without a warning, and a code-signing certificate for the setup program
(until then Windows SmartScreen asks: More info → Run anyway).

