// Writes Hearth's web page (docs/index.html in English, docs/ru/index.html in Russian). GitHub Pages serves the docs
// folder as https://viking818.github.io/hearth/. The words for both languages live here, so the two pages cannot
// drift apart. Usage: node scripts/build-site.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const REPO = 'https://github.com/Viking818/hearth';
const SITE = 'https://viking818.github.io/hearth/';
const FILES = {
  setup: { name: `Hearth-Setup-${VERSION}.exe`, mb: 24 },
  zip: { name: `Hearth-Windows-${VERSION}.zip`, mb: 35 },
  mac: { name: `Hearth-${VERSION}-mac-arm64.zip`, mb: 38 },
};
const fileUrl = (key) => `${REPO}/releases/download/v${VERSION}/${FILES[key].name}`;

// The same icons as in the app (Lucide, ISC license), taken from the app's own list.
const iconSource = fs.readFileSync(path.join(root, 'public/js/icons.js'), 'utf8');
function icon(name) {
  const m = iconSource.match(new RegExp(`(?:'${name}'|\\b${name}):\\s*'([^']*)'`));
  if (!m) throw new Error(`No icon named ${name}`);
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${m[1]}</svg>`;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const WORDS = {
  en: {
    lang: 'en',
    title: 'Hearth — AI that runs on your own computer',
    description:
      'A free app for Mac and Windows that runs open AI models on your own computer: chat, documents, voice, pictures, video and bots. No account, no subscription, no cloud.',
    navFeatures: 'What it does',
    navDownload: 'Download',
    navPrivacy: 'Privacy',
    otherLang: 'Русский',
    h1: 'AI that runs on your own computer',
    lead: 'Hearth is a free app for Mac and Windows. It downloads open AI models and runs them on your machine: chat, documents, voice, pictures, video and bots that work for you. No account, no subscription, no cloud.',
    download: 'Download',
    downloadWin: 'Download for Windows',
    downloadMac: 'Download for Mac',
    hintWin: 'Setup program. No administrator rights needed.',
    hintMac: 'For a Mac with Apple Silicon (M1 or newer).',
    hintOther: 'For Windows 10 and 11, and for a Mac with Apple Silicon.',
    github: 'Source code on GitHub',
    under: 'Free and open source · version',
    heroAlt: 'The Hearth chat window',
    facts: [
      ['shield', 'Everything stays with you', 'Your chats and files live in a folder on your computer. Hearth listens to this computer only.'],
      ['download', 'No account, no subscription', 'Download it and use it. The models are open and free, and you choose which ones to get.'],
      ['cpu', 'Your processor or graphics card', 'Hearth checks your computer and marks the models that will run well on it.'],
    ],
    showTitle: 'What it does',
    shows: [
      ['models.png', 'It tells you which model fits', 'Open Models and Hearth shows your processor, memory and graphics card, then marks the sizes that run well. Models you already have in LM Studio or Ollama are found and used as they are.', 'The Models screen with the sizes that run well marked'],
      ['bots.png', 'Bots that work on their own', 'Give a bot a task or a schedule, and write to it from your phone through its own Telegram bot, by text or by voice. It reads the files you send and writes documents and tables back.', 'The Bots screen'],
      ['voice.png', 'Talk instead of typing', 'Speak a question, or have a whole conversation by voice. Speech is recognized on your computer, and answers can be read aloud in a natural voice.', 'Voice settings'],
      ['customize.png', 'Connect your services', 'Connectors, skills and plugins in Claude’s formats, with a directory of about 60 services. Each connector is off until you switch it on.', 'The Customize screen with connectors'],
    ],
    phoneTitle: 'From your phone, too',
    phoneText: 'Scan a QR code on the computer’s screen and use the whole app from a phone or tablet on the same Wi-Fi. The model still runs on your computer.',
    phoneAlt: 'Hearth on a phone',
    moreTitle: 'And more',
    more: [
      ['message-square', 'Chat with documents', 'Text, images, PDF, Word, Excel and PowerPoint. Search every chat, branch a conversation, pin and archive.'],
      ['globe', 'It looks things up', 'The model searches the web, opens pages and reads the folders you allow. Every step shows in the chat.'],
      ['image', 'Pictures and video', 'Draw pictures and make short clips with sound, on your own graphics card.'],
      ['palette', 'Design and small apps', 'Posters, social posts, logos and small web apps the model writes, with a live preview.'],
      ['table', 'Hundreds of files at once', 'One instruction for a folder of photos or documents, saved as an Excel table.'],
      ['terminal', 'A model for other apps', 'A local API that speaks the OpenAI and Anthropic formats, for coding tools and anything else that uses them.'],
    ],
    dlTitle: 'Download Hearth',
    dlLead: 'Free. Node.js comes inside the packages, so there is nothing else to install.',
    dl: [
      ['setup', 'Windows 10 or 11', 'Setup program', 'Run it. No administrator rights are needed. It adds Start menu and desktop shortcuts.'],
      ['mac', 'Mac with Apple Silicon', 'M1 or newer', 'Unzip it and move Hearth to Applications.'],
      ['zip', 'Windows, without installing', 'Zip archive', 'Unzip it anywhere and double-click Hearth.vbs.'],
    ],
    dlButton: 'Download',
    mbUnit: 'MB',
    linux: 'Linux, or a Mac with an Intel chip? Hearth runs from the source code:',
    linuxLink: 'how to run it',
    warnTitle: 'The first start shows a warning',
    warnText: 'The packages are not signed yet, so the system asks before opening them.',
    warnWin: '<b>Windows:</b> “Windows protected your PC” → <b>More info</b> → <b>Run anyway</b>.',
    warnMac: '<b>Mac:</b> System Settings → Privacy &amp; Security → <b>Open Anyway</b> next to Hearth.',
    stepsTitle: 'First steps',
    steps: [
      'Open <b>Models</b>. Hearth shows your processor, memory and graphics card.',
      'Click <b>Download engine</b> if the Engine card asks for it. Hearth picks the right build for your computer.',
      'Pick a model marked <b>Runs well</b> and download it.',
      'Click <b>Load</b> and start chatting.',
    ],
    needTitle: 'What your computer needs',
    needs: [
      '<b>Memory:</b> 16 GB runs the small models well; 32 GB or more runs the strong ones. A graphics card with 8 GB or more makes everything faster, but is not required.',
      '<b>Disk:</b> a model takes from 4 GB to 80 GB. Pictures need about 11 GB more, video about 25 GB more.',
      'Hearth ships no model and no engine. It downloads what you choose, when you press Download.',
    ],
    privTitle: 'Privacy',
    priv: [
      'Hearth runs on your computer and listens on this computer only. Your chats and files stay in your own data folder.',
      'Nothing is sent anywhere unless you use a tool that needs the internet: a web search, opening a page, a connector you switched on, or a Telegram bot you connected.',
      'Web tools open public addresses only, never your computer or home network. Bots write only inside their own work folder.',
      'Everything Hearth downloads to run comes from its maker’s official releases and is checked against a checksum first.',
    ],
    footMade: 'Hearth is a personal project, free under the MIT license.',
    footFeatures: 'All features',
    footIssues: 'Report a problem',
    footReleases: 'All versions',
    footNote: 'The screenshots show sample data.',
  },
  ru: {
    lang: 'ru',
    title: 'Hearth — ИИ, который работает на вашем компьютере',
    description:
      'Бесплатная программа для Mac и Windows: запускает открытые модели ИИ на вашем компьютере. Чат, документы, голос, картинки, видео и боты. Без аккаунта, без подписки, без облака.',
    navFeatures: 'Что умеет',
    navDownload: 'Скачать',
    navPrivacy: 'Приватность',
    otherLang: 'English',
    h1: 'ИИ, который работает на вашем компьютере',
    lead: 'Hearth — бесплатная программа для Mac и Windows. Она скачивает открытые модели ИИ и запускает их на вашем компьютере: чат, документы, голос, картинки, видео и боты, которые работают за вас. Без аккаунта, без подписки, без облака.',
    download: 'Скачать',
    downloadWin: 'Скачать для Windows',
    downloadMac: 'Скачать для Mac',
    hintWin: 'Установщик. Права администратора не нужны.',
    hintMac: 'Для Mac с Apple Silicon (M1 и новее).',
    hintOther: 'Для Windows 10 и 11 и для Mac с Apple Silicon.',
    github: 'Исходный код на GitHub',
    under: 'Бесплатно, с открытым кодом · версия',
    heroAlt: 'Окно чата Hearth',
    facts: [
      ['shield', 'Всё остаётся у вас', 'Чаты и файлы лежат в папке на вашем компьютере. Hearth слушает только этот компьютер.'],
      ['download', 'Без аккаунта и подписки', 'Скачали и пользуетесь. Модели открытые и бесплатные, какие скачать — выбираете вы.'],
      ['cpu', 'Ваш процессор или видеокарта', 'Hearth проверяет компьютер и отмечает модели, которые будут на нём хорошо работать.'],
    ],
    showTitle: 'Что умеет',
    shows: [
      ['models.png', 'Подскажет, какая модель подойдёт', 'Откройте «Модели»: Hearth покажет процессор, память и видеокарту и отметит размеры, которые работают хорошо. Модели, которые уже есть в LM Studio или Ollama, он найдёт и возьмёт как есть.', 'Экран «Модели» с отмеченными подходящими размерами'],
      ['bots.png', 'Боты, которые работают сами', 'Дайте боту задачу или расписание и пишите ему с телефона через его собственный бот в Telegram, текстом или голосом. Он читает присланные файлы и присылает в ответ документы и таблицы.', 'Экран «Боты»'],
      ['voice.png', 'Говорите вместо набора', 'Задайте вопрос голосом или ведите голосом весь разговор. Речь распознаётся на вашем компьютере, а ответы можно слушать живым голосом.', 'Настройки голоса'],
      ['customize.png', 'Подключите свои сервисы', 'Коннекторы, навыки и плагины в форматах Claude, с каталогом примерно из 60 сервисов. Каждый коннектор выключен, пока вы его не включите.', 'Экран «Настроить» с коннекторами'],
    ],
    phoneTitle: 'И с телефона',
    phoneText: 'Отсканируйте QR-код на экране компьютера и пользуйтесь всей программой с телефона или планшета в той же сети Wi-Fi. Модель при этом работает на компьютере.',
    phoneAlt: 'Hearth на телефоне',
    moreTitle: 'И ещё',
    more: [
      ['message-square', 'Чат с документами', 'Текст, картинки, PDF, Word, Excel и PowerPoint. Поиск по всем чатам, ветки разговора, закрепление и архив.'],
      ['globe', 'Сама ищет ответ', 'Модель ищет в интернете, открывает страницы и читает папки, которые вы разрешили. Каждый шаг виден в чате.'],
      ['image', 'Картинки и видео', 'Рисует картинки и делает короткие ролики со звуком на вашей видеокарте.'],
      ['palette', 'Дизайн и мини-приложения', 'Афиши, посты для соцсетей, логотипы и небольшие веб-приложения, которые пишет модель, с живым предпросмотром.'],
      ['table', 'Сотни файлов за раз', 'Одна инструкция для папки с фото или документами, результат — таблица Excel.'],
      ['terminal', 'Модель для других программ', 'Локальный API в форматах OpenAI и Anthropic: для инструментов программиста и всего, что умеет с ними работать.'],
    ],
    dlTitle: 'Скачать Hearth',
    dlLead: 'Бесплатно. Node.js уже внутри пакетов, больше ничего ставить не нужно.',
    dl: [
      ['setup', 'Windows 10 или 11', 'Установщик', 'Запустите его. Права администратора не нужны. Появятся ярлыки в меню «Пуск» и на рабочем столе.'],
      ['mac', 'Mac с Apple Silicon', 'M1 и новее', 'Распакуйте архив и перенесите Hearth в «Программы».'],
      ['zip', 'Windows, без установки', 'Архив zip', 'Распакуйте куда угодно и дважды щёлкните Hearth.vbs.'],
    ],
    dlButton: 'Скачать',
    mbUnit: 'МБ',
    linux: 'Linux или Mac с процессором Intel? Hearth запускается из исходного кода:',
    linuxLink: 'как запустить',
    warnTitle: 'При первом запуске появится предупреждение',
    warnText: 'Пакеты пока не подписаны, поэтому система спрашивает, открывать ли их.',
    warnWin: '<b>Windows:</b> «Система Windows защитила ваш компьютер» → <b>Подробнее</b> → <b>Выполнить в любом случае</b>.',
    warnMac: '<b>Mac:</b> «Системные настройки» → «Конфиденциальность и безопасность» → <b>Всё равно открыть</b> рядом с Hearth.',
    stepsTitle: 'Первые шаги',
    steps: [
      'Откройте <b>«Модели»</b>. Hearth покажет процессор, память и видеокарту.',
      'Нажмите <b>«Скачать движок»</b>, если карточка «Движок» об этом просит. Hearth сам выберет сборку для вашего компьютера.',
      'Выберите модель с пометкой <b>«Работает хорошо»</b> и скачайте её.',
      'Нажмите <b>«Загрузить»</b> и начинайте разговор.',
    ],
    needTitle: 'Что нужно компьютеру',
    needs: [
      '<b>Память:</b> на 16 ГБ хорошо работают небольшие модели, на 32 ГБ и больше — сильные. Видеокарта с 8 ГБ и больше всё ускоряет, но она не обязательна.',
      '<b>Диск:</b> модель занимает от 4 до 80 ГБ. Для картинок нужно ещё около 11 ГБ, для видео — около 25 ГБ.',
      'В самом Hearth нет ни моделей, ни движка. Он скачивает то, что выбрали вы, когда вы нажимаете «Скачать».',
    ],
    privTitle: 'Приватность',
    priv: [
      'Hearth работает на вашем компьютере и слушает только его. Чаты и файлы остаются в вашей папке данных.',
      'Никуда ничего не отправляется, пока вы не воспользуетесь тем, чему нужен интернет: поиском в сети, открытием страницы, включённым коннектором или подключённым ботом в Telegram.',
      'Веб-инструменты открывают только общедоступные адреса и никогда — ваш компьютер или домашнюю сеть. Боты пишут только в свою рабочую папку.',
      'Всё, что Hearth скачивает для запуска, берётся из официальных выпусков авторов и сначала сверяется с контрольной суммой.',
    ],
    footMade: 'Hearth — личный проект, бесплатный, под лицензией MIT.',
    footFeatures: 'Все возможности (англ.)',
    footIssues: 'Сообщить о проблеме',
    footReleases: 'Все версии',
    footNote: 'На снимках экрана — учебные данные.',
  },
};

function page(w) {
  const up = w.lang === 'en' ? '' : '../'; // the Russian page lives one folder down
  const other = w.lang === 'en' ? 'ru/' : '../';
  const own = w.lang === 'en' ? SITE : `${SITE}ru/`;
  const readme = w.lang === 'en' ? `${REPO}#run-from-source` : `${REPO}/blob/main/README.ru.md`;
  const shot = (file, alt, eager) =>
    `<img src="${up}screenshots/${file}" width="1800" height="1250" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  return `<!doctype html>
<html lang="${w.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.title)}</title>
<meta name="description" content="${esc(w.description)}">
<link rel="canonical" href="${own}">
<link rel="alternate" hreflang="en" href="${SITE}">
<link rel="alternate" hreflang="ru" href="${SITE}ru/">
<link rel="alternate" hreflang="x-default" href="${SITE}">
<link rel="icon" href="${up}logo.svg" type="image/svg+xml">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(w.title)}">
<meta property="og:description" content="${esc(w.description)}">
<meta property="og:url" content="${own}">
<meta property="og:image" content="${SITE}social.png">
<meta property="og:image:width" content="1280">
<meta property="og:image:height" content="640">
<meta name="twitter:card" content="summary_large_image">
<meta name="color-scheme" content="light dark">
<link rel="stylesheet" href="${up}site.css">
</head>
<body data-lang="${w.lang}">
<header class="top">
  <div class="wrap top-in">
    <a class="brand" href="#top"><img src="${up}logo.svg" width="28" height="28" alt=""><span>Hearth</span></a>
    <nav class="nav">
      <a href="#features">${w.navFeatures}</a>
      <a href="#privacy">${w.navPrivacy}</a>
      <a href="${REPO}">GitHub</a>
      <a class="lang" href="${other}" hreflang="${w.lang === 'en' ? 'ru' : 'en'}" data-lang-link>${w.otherLang}</a>
      <a class="btn small" href="#download">${w.navDownload}</a>
    </nav>
  </div>
</header>

<main id="top">
<section class="hero wrap">
  <h1>${w.h1}</h1>
  <p class="lead">${w.lead}</p>
  <div class="cta">
    <a class="btn big" href="#download" data-main-download data-win="${esc(w.downloadWin)}" data-mac="${esc(w.downloadMac)}">${icon('download')}<span>${w.download}</span></a>
    <a class="btn big ghost" href="${REPO}">${w.github}</a>
  </div>
  <p class="under"><span data-hint data-win="${esc(w.hintWin)}" data-mac="${esc(w.hintMac)}">${w.hintOther}</span> ${w.under} <span data-version>${VERSION}</span>.</p>
  <div class="frame hero-shot">
    <picture>
      <source srcset="${up}screenshots/chat-dark.png" media="(prefers-color-scheme: dark)">
      ${shot('chat.png', w.heroAlt, true)}
    </picture>
  </div>
</section>

<section class="wrap facts">
${w.facts.map(([i, t, d]) => `  <div class="fact">${icon(i)}<h3>${t}</h3><p>${d}</p></div>`).join('\n')}
</section>

<section class="wrap" id="features">
  <h2>${w.showTitle}</h2>
${w.shows
  .map(
    ([file, t, d, alt], n) => `  <div class="show${n % 2 ? ' flip' : ''}">
    <div class="show-text"><h3>${t}</h3><p>${d}</p></div>
    <div class="frame">${shot(file, alt)}</div>
  </div>`,
  )
  .join('\n')}
  <div class="show phone">
    <div class="show-text"><h3>${w.phoneTitle}</h3><p>${w.phoneText}</p></div>
    <div class="phone-shot"><img src="${up}screenshots/phone.png" width="508" height="1100" alt="${esc(w.phoneAlt)}" loading="lazy" decoding="async"></div>
  </div>
</section>

<section class="wrap">
  <h2>${w.moreTitle}</h2>
  <div class="grid">
${w.more.map(([i, t, d]) => `    <div class="card">${icon(i)}<h3>${t}</h3><p>${d}</p></div>`).join('\n')}
  </div>
</section>

<section class="band" id="download">
  <div class="wrap">
    <h2>${w.dlTitle}</h2>
    <p class="band-lead">${w.dlLead} <span class="muted">${w.under.split('·')[1].trim()} <span data-version>${VERSION}</span></span></p>
    <div class="files">
${w.dl
  .map(
    ([key, t, kind, d]) => `      <div class="file" data-os="${key === 'mac' ? 'mac' : 'win'}">
        <h3>${t}</h3>
        <p class="kind">${kind} · <span data-size="${key}">${FILES[key].mb}</span> ${w.mbUnit}</p>
        <p>${d}</p>
        <a class="btn" href="${fileUrl(key)}" data-asset="${key}">${icon('download')}<span>${w.dlButton}</span></a>
      </div>`,
  )
  .join('\n')}
    </div>
    <p class="linux">${w.linux} <a href="${readme}">${w.linuxLink}</a>.</p>
    <div class="notes">
      <div class="note warn">
        <h3>${w.warnTitle}</h3>
        <p>${w.warnText}</p>
        <ul><li>${w.warnWin}</li><li>${w.warnMac}</li></ul>
      </div>
      <div class="note">
        <h3>${w.stepsTitle}</h3>
        <ol>${w.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
      </div>
      <div class="note">
        <h3>${w.needTitle}</h3>
        <ul>${w.needs.map((s) => `<li>${s}</li>`).join('')}</ul>
      </div>
    </div>
  </div>
</section>

<section class="wrap" id="privacy">
  <h2>${w.privTitle}</h2>
  <ul class="priv">
${w.priv.map((s) => `    <li>${icon('shield')}<span>${s}</span></li>`).join('\n')}
  </ul>
</section>
</main>

<footer class="foot">
  <div class="wrap foot-in">
    <p>${w.footMade} ${w.footNote}</p>
    <p class="foot-links"><a href="${REPO}">GitHub</a><a href="${REPO}/blob/main/docs/FEATURES.md">${w.footFeatures}</a><a href="${REPO}/releases">${w.footReleases}</a><a href="${REPO}/issues">${w.footIssues}</a><a href="${other}" data-lang-link>${w.otherLang}</a></p>
  </div>
</footer>
<script src="${up}site.js" defer></script>
</body>
</html>
`;
}

const docs = path.join(root, 'docs');
fs.mkdirSync(path.join(docs, 'ru'), { recursive: true });
fs.writeFileSync(path.join(docs, 'index.html'), page(WORDS.en));
fs.writeFileSync(path.join(docs, 'ru', 'index.html'), page(WORDS.ru));
fs.copyFileSync(path.join(root, 'public/logo.svg'), path.join(docs, 'logo.svg'));
fs.writeFileSync(path.join(docs, '.nojekyll'), ''); // serve the files as they are
console.log(`Wrote docs/index.html and docs/ru/index.html for Hearth ${VERSION}`);
