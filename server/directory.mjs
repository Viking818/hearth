// The connector directory: well-known services that offer an MCP server, with their logos, in groups, the way
// Claude's Customize page shows them. Connecting one adds it to the user's own connectors and opens the service's
// sign-in page in the browser. How each service lets apps in was checked on 2026-11-08:
//   oauth    — its own sign-in page opens, and Hearth registers itself there (dynamic client registration)
//   open     — works without an account (some of its tools may still need one)
//   token    — new apps can't sign in, but the service gives out access tokens to paste (GitHub)
//   approved — only apps the service approved in advance (Claude, ChatGPT…) may sign in: not possible from Hearth
// Logos are in public/brands (see the README there): Simple Icons (CC0) in each brand's colour, or the service's icon.
import { t } from './i18n.mjs';
import { ownConnectors, editOwnConnectors, ensureMcp, mcpServers, signInConnector } from './mcp.mjs';
import { advertisesSignIn } from './oauth.mjs';

export const CATEGORIES = [
  { id: 'design', title: 'Design & media' },
  { id: 'docs', title: 'Documents & mail' },
  { id: 'shop', title: 'Shop & payments' },
  { id: 'web', title: 'Websites' },
  { id: 'marketing', title: 'Social & marketing' },
  { id: 'work', title: 'Tasks & team' },
  { id: 'dev', title: 'Developers' },
];

const GOOGLE = 'Google lets only apps it approved sign in, so Hearth can’t connect to it directly. Zapier can reach it for you.';
const APPROVED = 'This service lets only apps it approved in advance sign in, so Hearth can’t connect to it directly. Zapier can reach it for you.';
const FIGMA = 'Figma lets only apps it approved sign in to its online server. With the Figma desktop app, you can turn on its own server instead (Quick actions → “Enable desktop MCP server”, on paid plans) and add it with “Add your own” at the address http://127.0.0.1:3845/mcp.';
const MAILCHIMP = 'Mailchimp’s server turns away apps it doesn’t know (it answers “Access Denied”), so Hearth can’t connect to it directly. Zapier can reach Mailchimp for you.';

// Directory addresses that changed: a connector added with the old one is moved to the new one when Hearth starts.
export const MOVED = { 'https://mcp.higgsfield.ai': 'https://mcp.higgsfield.ai/mcp' };

export const DIRECTORY = [
  // Design & media
  { id: 'canva', name: 'Canva', category: 'design', url: 'https://mcp.canva.com/mcp', auth: 'oauth', logo: 'canva.png', site: 'canva.com', featured: true, description: 'Search, create, fill in and export your Canva designs.' },
  { id: 'higgsfield', name: 'Higgsfield', category: 'design', url: 'https://mcp.higgsfield.ai/mcp', auth: 'oauth', logo: 'higgsfield.png', site: 'higgsfield.ai', featured: true, description: 'Make AI pictures and videos with Higgsfield’s models, and keep them in your library.' },
  { id: 'figma', name: 'Figma', category: 'design', url: 'https://mcp.figma.com/mcp', auth: 'approved', logo: 'figma.svg', site: 'figma.com', featured: true, note: FIGMA, description: 'Read your Figma designs: layouts, screenshots, colours and text.' },
  { id: 'adobe', name: 'Adobe', category: 'design', url: 'https://adobe-creativity.adobe.io/mcp', auth: 'oauth', logo: 'adobe.png', site: 'adobe.com', description: 'Edit photos and PDFs and make designs with Adobe’s tools.' },
  { id: 'orshot', name: 'Orshot', category: 'design', url: 'https://mcp.orshot.com/mcp', auth: 'oauth', logo: 'orshot.png', site: 'orshot.com', description: 'Pictures, videos and PDFs from your templates, for social posts and marketing.' },
  { id: 'moda', name: 'Moda', category: 'design', url: 'https://agents.moda.app/mcp', auth: 'oauth', logo: 'moda.png', site: 'moda.app', description: 'Editable slides, ads, motion graphics and social pictures.' },
  { id: 'miro', name: 'Miro', category: 'design', url: 'https://mcp.miro.com/', auth: 'oauth', logo: 'miro.svg', site: 'miro.com', description: 'Read and add to your Miro boards: notes, diagrams and documents.' },
  // Documents & mail
  { id: 'notion', name: 'Notion', category: 'docs', url: 'https://mcp.notion.com/mcp', auth: 'oauth', logo: 'notion.svg', site: 'notion.so', featured: true, description: 'Search, read and update your Notion pages and databases.' },
  { id: 'gmail', name: 'Gmail', category: 'docs', url: 'https://gmailmcp.googleapis.com/mcp/v1', auth: 'approved', logo: 'gmail.svg', site: 'mail.google.com', note: GOOGLE, description: 'Search your mail, read threads and draft replies.' },
  { id: 'googlecalendar', name: 'Google Calendar', category: 'docs', url: 'https://calendarmcp.googleapis.com/mcp/v1', auth: 'approved', logo: 'googlecalendar.svg', site: 'calendar.google.com', note: GOOGLE, description: 'Your schedule: events, meetings and free time.' },
  { id: 'googledrive', name: 'Google Drive', category: 'docs', url: 'https://drivemcp.googleapis.com/mcp/v1', auth: 'approved', logo: 'googledrive.svg', site: 'drive.google.com', note: GOOGLE, description: 'Search, read and upload your files.' },
  { id: 'googledocs', name: 'Google Docs', category: 'docs', url: 'https://docsmcp.googleapis.com/mcp/v1', auth: 'approved', logo: 'googledocs.svg', site: 'docs.google.com', note: GOOGLE, description: 'Read and edit your documents.' },
  { id: 'dropbox', name: 'Dropbox', category: 'docs', url: 'https://mcp.dropbox.com/claude_app_mcp', auth: 'oauth', logo: 'dropbox.svg', site: 'dropbox.com', description: 'Search, organize and share your Dropbox files.' },
  { id: 'box', name: 'Box', category: 'docs', url: 'https://mcp.box.com/', auth: 'approved', logo: 'box.svg', site: 'box.com', note: APPROVED, description: 'Search and read your Box files.' },
  { id: 'airtable', name: 'Airtable', category: 'docs', url: 'https://mcp.airtable.com/mcp', auth: 'oauth', logo: 'airtable.svg', site: 'airtable.com', description: 'Read and add records in your Airtable bases.' },
  { id: 'calendly', name: 'Calendly', category: 'docs', url: 'https://mcp.calendly.com/', auth: 'oauth', logo: 'calendly.svg', site: 'calendly.com', description: 'Your event types, bookings and free times.' },
  // Shop & payments
  { id: 'shopify', name: 'Shopify', category: 'shop', url: 'https://setup.shopify.com/mcp', auth: 'open', logo: 'shopify.svg', site: 'shopify.com', featured: true, note: 'Without an account: ideas for a new store (names, domains, previews). Connecting an existing store isn’t possible from Hearth yet.', description: 'Start a Shopify store: business names, domains and store previews.' },
  { id: 'fourthwall', name: 'Fourthwall', category: 'shop', url: 'https://mcp.fourthwall.com/app', auth: 'oauth', logo: 'fourthwall.png', site: 'fourthwall.com', featured: true, description: 'Custom merch and streetwear: products, your shop and orders.' },
  { id: 'paypal', name: 'PayPal', category: 'shop', url: 'https://mcp.paypal.com/mcp', auth: 'oauth', logo: 'paypal.svg', site: 'paypal.com', description: 'Invoices, products, payments and disputes.' },
  { id: 'stripe', name: 'Stripe', category: 'shop', url: 'https://mcp.stripe.com/', auth: 'oauth', logo: 'stripe.svg', site: 'stripe.com', description: 'Payments, customers and balances.' },
  { id: 'square', name: 'Square', category: 'shop', url: 'https://mcp.squareup.com/mcp', auth: 'oauth', logo: 'square.svg', site: 'squareup.com', description: 'Sales, payments and shop data.' },
  { id: 'aftership', name: 'AfterShip for TikTok Shop', category: 'shop', url: 'https://mcp.aftership.com/channels', auth: 'oauth', logo: 'aftership.svg', site: 'aftership.com', description: 'List and sync your products and orders on TikTok Shop.' },
  { id: 'shipbob', name: 'ShipBob', category: 'shop', url: 'https://api.shipbob.com/developer-api/mcp', auth: 'oauth', logo: 'shipbob.svg', site: 'shipbob.com', description: 'Orders, stock and shipments.' },
  { id: 'mercury', name: 'Mercury', category: 'shop', url: 'https://mcp.mercury.com/mcp', auth: 'oauth', logo: 'mercury.svg', site: 'mercury.com', description: 'Your business bank: accounts, transactions and payments for approval.' },
  // Websites
  { id: 'hostinger', name: 'Hostinger', category: 'web', url: 'https://mcp.hostinger.com/', auth: 'oauth', logo: 'hostinger.svg', site: 'hostinger.com', featured: true, description: 'Websites, online stores, domains, DNS, email and hosting at Hostinger.' },
  { id: 'wix', name: 'Wix', category: 'web', url: 'https://mcp.wix.com/mcp', auth: 'oauth', logo: 'wix.svg', site: 'wix.com', description: 'Build and manage Wix sites.' },
  { id: 'webflow', name: 'Webflow', category: 'web', url: 'https://mcp.webflow.com/mcp', auth: 'oauth', logo: 'webflow.svg', site: 'webflow.com', description: 'Pages, CMS content and publishing on Webflow.' },
  { id: 'squarespace', name: 'Squarespace', category: 'web', url: 'https://mcp.squarespace.com/mcp', auth: 'open', logo: 'squarespace.svg', site: 'squarespace.com', description: 'Find a domain name for your idea.' },
  { id: 'b12', name: 'B12', category: 'web', url: 'https://mcp.b12.io/mcp', auth: 'open', logo: 'b12.png', site: 'b12.io', description: 'Make a website from a description.' },
  // Social & marketing
  { id: 'metricool', name: 'Metricool', category: 'marketing', url: 'https://ai.metricool.com/mcp', auth: 'oauth', logo: 'metricool.png', site: 'metricool.com', featured: true, description: 'Schedule posts and see results for Instagram, TikTok, Facebook, Pinterest and more.' },
  { id: 'windsor', name: 'Windsor.ai Social', category: 'marketing', url: 'https://mcp.windsor.ai/social_media', auth: 'oauth', logo: 'windsor.png', site: 'windsor.ai', description: 'Post and see results on Instagram, Facebook, TikTok, YouTube and LinkedIn.' },
  { id: 'typefully', name: 'Typefully', category: 'marketing', url: 'https://mcp.typefully.com/mcp', auth: 'oauth', logo: 'typefully.png', site: 'typefully.com', description: 'Write and schedule posts for X, LinkedIn, Threads and Bluesky.' },
  { id: 'vidiq', name: 'vidIQ', category: 'marketing', url: 'https://mcp.vidiq.com/mcp', auth: 'oauth', logo: 'vidiq.png', site: 'vidiq.com', description: 'Ideas, keywords and trends for YouTube, Instagram and TikTok.' },
  { id: 'tiktokads', name: 'TikTok for Business', category: 'marketing', url: 'https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer-anthropic', auth: 'oauth', logo: 'tiktok.svg', site: 'tiktok.com', description: 'Create and analyze TikTok ad campaigns.' },
  { id: 'klaviyo', name: 'Klaviyo', category: 'marketing', url: 'https://mcp.klaviyo.com/mcp', auth: 'oauth', logo: 'klaviyo.png', site: 'klaviyo.com', description: 'Email and SMS campaigns, flows and results.' },
  { id: 'mailchimp', name: 'Mailchimp', category: 'marketing', url: 'https://ai-inc.mailchimp.com/claude/mcp/v2', auth: 'approved', logo: 'mailchimp.svg', site: 'mailchimp.com', note: MAILCHIMP, description: 'Plan and build email campaigns.' },
  { id: 'beehiiv', name: 'beehiiv', category: 'marketing', url: 'https://mcp.beehiiv.com/mcp', auth: 'oauth', logo: 'beehiiv.png', site: 'beehiiv.com', description: 'Newsletters: drafts, posts and results.' },
  { id: 'supermetrics', name: 'Supermetrics', category: 'marketing', url: 'https://mcp.supermetrics.com/mcp', auth: 'oauth', logo: 'supermetrics.png', site: 'supermetrics.com', description: 'Ad and social results from Google, Meta, TikTok and more in one place.' },
  { id: 'hubspot', name: 'HubSpot', category: 'marketing', url: 'https://mcp.hubspot.com/anthropic', auth: 'approved', logo: 'hubspot.svg', site: 'hubspot.com', note: APPROVED, description: 'CRM: contacts, deals and marketing.' },
  // Tasks & team
  { id: 'zapier', name: 'Zapier', category: 'work', url: 'https://mcp.zapier.com/api/v1/connect', auth: 'oauth', logo: 'zapier.svg', site: 'zapier.com', featured: true, description: 'Thousands of apps (Gmail, Google Sheets, Slack…) through your Zapier account.' },
  { id: 'trello', name: 'Trello', category: 'work', url: 'https://mcp.trello.com/v1', auth: 'oauth', logo: 'trello.svg', site: 'trello.com', description: 'Boards, lists and cards.' },
  { id: 'clickup', name: 'ClickUp', category: 'work', url: 'https://mcp.clickup.com/mcp', auth: 'oauth', logo: 'clickup.svg', site: 'clickup.com', description: 'Tasks, documents and projects.' },
  { id: 'monday', name: 'monday.com', category: 'work', url: 'https://mcp.monday.com/mcp', auth: 'oauth', logo: 'monday.png', site: 'monday.com', description: 'Boards, items, workflows and dashboards.' },
  { id: 'todoist', name: 'Todoist', category: 'work', url: 'https://ai.todoist.net/mcp', auth: 'oauth', logo: 'todoist.svg', site: 'todoist.com', description: 'Your tasks and projects.' },
  { id: 'linear', name: 'Linear', category: 'work', url: 'https://mcp.linear.app/mcp', auth: 'oauth', logo: 'linear.svg', site: 'linear.app', description: 'Issues, projects and cycles.' },
  { id: 'atlassian', name: 'Atlassian', category: 'work', url: 'https://mcp.atlassian.com/v2/mcp', auth: 'oauth', logo: 'atlassian.svg', site: 'atlassian.com', description: 'Jira issues and Confluence pages.' },
  { id: 'intercom', name: 'Intercom', category: 'work', url: 'https://mcp.intercom.com/mcp', auth: 'oauth', logo: 'intercom.svg', site: 'intercom.com', description: 'Customer conversations and contacts.' },
  { id: 'pipedrive', name: 'Pipedrive', category: 'work', url: 'https://mcp.pipedrive.ai/mcp', auth: 'oauth', logo: 'pipedrive.png', site: 'pipedrive.com', description: 'Deals, contacts and activities.' },
  { id: 'asana', name: 'Asana', category: 'work', url: 'https://mcp.asana.com/v2/mcp', auth: 'approved', logo: 'asana.svg', site: 'asana.com', note: APPROVED, description: 'Tasks, projects and goals.' },
  { id: 'slack', name: 'Slack', category: 'work', url: 'https://mcp.slack.com/mcp', auth: 'approved', logo: 'slack.png', site: 'slack.com', note: APPROVED, description: 'Messages, channels and canvases.' },
  { id: 'zoom', name: 'Zoom', category: 'work', url: 'https://mcp.zoom.us/mcp/zoom/streamable', auth: 'approved', logo: 'zoom.svg', site: 'zoom.us', note: APPROVED, description: 'Your meetings, recordings and recaps.' },
  // Developers
  { id: 'github', name: 'GitHub', category: 'dev', url: 'https://api.githubcopilot.com/mcp/', auth: 'token', logo: 'github.svg', site: 'github.com', note: 'GitHub doesn’t let new apps sign in: paste a personal access token from GitHub instead.', description: 'Repositories, issues and pull requests.' },
  { id: 'vercel', name: 'Vercel', category: 'dev', url: 'https://mcp.vercel.com/', auth: 'oauth', logo: 'vercel.svg', site: 'vercel.com', description: 'Projects, deployments and logs.' },
  { id: 'supabase', name: 'Supabase', category: 'dev', url: 'https://mcp.supabase.com/mcp', auth: 'oauth', logo: 'supabase.svg', site: 'supabase.com', description: 'Databases, sign-ins and storage.' },
  { id: 'cloudflare', name: 'Cloudflare', category: 'dev', url: 'https://bindings.mcp.cloudflare.com/mcp', auth: 'oauth', logo: 'cloudflare.svg', site: 'cloudflare.com', description: 'Workers, storage and AI on Cloudflare.' },
  { id: 'sentry', name: 'Sentry', category: 'dev', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth', logo: 'sentry.svg', site: 'sentry.io', description: 'Errors in your apps, and what caused them.' },
  { id: 'huggingface', name: 'Hugging Face', category: 'dev', url: 'https://huggingface.co/mcp', auth: 'open', logo: 'huggingface.svg', site: 'huggingface.co', description: 'Find models, datasets and apps on the Hugging Face Hub.' },
  { id: 'mapbox', name: 'Mapbox', category: 'dev', url: 'https://mcp.mapbox.com/mcp', auth: 'oauth', logo: 'mapbox.svg', site: 'mapbox.com', description: 'Places, addresses, routes and maps.' },
];

// The directory in the page's language.
export function directory() {
  return {
    categories: CATEGORIES.map((c) => ({ id: c.id, name: t(c.title) })),
    items: DIRECTORY.map((d) => ({ ...d, description: t(d.description), note: d.note ? t(d.note) : '' })),
  };
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// One click: the service joins the user's own connectors (under its id), Hearth connects to it, and when it asks for
// a sign-in, the service's own sign-in page opens in the browser. Returns { url } when a sign-in page was opened.
export async function connectFromDirectory(id, { redirectUri, open } = {}) {
  const d = DIRECTORY.find((x) => x.id === id);
  if (!d) throw bad(t('Not found'), 404);
  if (d.auth === 'approved') throw bad(t(d.note || APPROVED));
  const same = ownConnectors().find((c) => c.name === id || (c.cfg?.url && c.cfg.url === d.url));
  const name = same?.name || id;
  editOwnConnectors((list) => {
    list[name] = { ...(list[name] || {}), type: 'http', url: d.url };
    delete list[name].disabled;
  });
  await ensureMcp({ force: name });
  const st = mcpServers().find((s) => s.name === name);
  if (st?.status === 'signin' && st.auth?.canSignIn !== false && !st.auth?.signedIn) {
    const r = await signInConnector(name, { redirectUri, ...(open ? { open } : {}) });
    return { name, url: r.url };
  }
  // It connects without an account, but its tools want one (Fourthwall's): sign in now, not at the first tool.
  if (st?.status === 'ready' && d.auth === 'oauth' && st.auth && !st.auth.signedIn && (await advertisesSignIn(d.url))) {
    const r = await signInConnector(name, { redirectUri, ...(open ? { open } : {}) }).catch(() => null);
    if (r) return { name, url: r.url };
  }
  return { name, url: '' };
}

// Connectors added from the directory at an address that has since moved (Higgsfield's) go to the new one.
export function fixMovedConnectors() {
  const trim = (u) => String(u || '').replace(/\/+$/, '');
  const moved = ownConnectors().filter((c) => c.cfg?.url && MOVED[trim(c.cfg.url)]);
  if (!moved.length) return 0;
  editOwnConnectors((list) => {
    for (const c of moved) list[c.name] = { ...list[c.name], url: MOVED[trim(c.cfg.url)] };
  });
  return moved.length;
}
