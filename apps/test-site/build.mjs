#!/usr/bin/env node
/**
 * Build the demo website.
 *
 * Deliberately a 40-line script rather than a framework. The point of this site is to be an
 * ordinary customer website - plain HTML, its own CSS, no build tooling of ours anywhere near it -
 * so that when the widget works here, it works because the widget works, not because it shares a
 * bundler with the page.
 *
 * The installation snippet is injected from environment variables so the site can point at
 * whichever widget host it is running against.
 */
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'src');
const out = join(here, 'dist');

const WIDGET_URL = (process.env.WIDGET_URL ?? 'http://localhost:3003').replace(/\/$/, '');
const PROPERTY_ID = process.env.TEST_SITE_PROPERTY_ID ?? 'prp_DEMKTESTSTE00001';

const SNIPPET = `<!-- SmartChat -->
<script>
(function(w,d,s,u){
  w.SmartChat=w.SmartChat||function(){(w.SmartChat.q=w.SmartChat.q||[]).push(arguments)};
  var e=d.createElement(s);e.async=1;e.src=u;
  var f=d.getElementsByTagName(s)[0];f.parentNode.insertBefore(e,f);
})(window,document,'script','${WIDGET_URL}/v1/loader.js?p=${PROPERTY_ID}');
</script>
<!-- /SmartChat -->`;

await mkdir(out, { recursive: true });

for (const name of await readdir(source)) {
  const from = join(source, name);
  const to = join(out, name);

  if (name.endsWith('.html')) {
    const html = await readFile(from, 'utf8');
    await writeFile(to, html.replace('<!--SMARTCHAT_SNIPPET-->', SNIPPET), 'utf8');
    continue;
  }
  await cp(from, to, { recursive: true });
}

console.log(`test-site: built ${out} (widget ${WIDGET_URL}, property ${PROPERTY_ID})`);
