import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(root, 'demo', name), 'utf8');
let html = read('shell.html');
for (const [placeholder, file] of Object.entries({DEMO_CSS:'style.css',MARKED:'vendor/marked.js',HIGHLIGHT:'vendor/highlight.js',PURIFY:'vendor/purify.js',DEMO_JS:'demo.js'})) {
  let content = read(file);
  if (placeholder === 'DEMO_JS') {
    content = content.replace('/* ICON_DATA */', ['pause','sun','copy'].map(name => `icons.${name} = ${JSON.stringify(read(`icons/${name}.svg`).replace('<svg ', '<svg aria-hidden="true" '))};`).join('\n'));
  }
  content = content.replace(/<\/script/gi, '<\\/script');
  html = html.replace(`/* ${placeholder} */`, () => content);
}
html = html.replace(/@@([a-z-]+)@@/g, (_, name) => read(`icons/${name}.svg`).replace(/<\?xml[^>]*>/g, '').replace('<svg ', '<svg aria-hidden="true" '));
if (/@@[a-z-]+@@|\/\* (DEMO_|MARKED|HIGHLIGHT|PURIFY)/.test(html)) throw new Error('Unresolved demo placeholder');
fs.writeFileSync(path.join(root, 'arkcode-tui-demo.html'), html);
console.log(`Built standalone demo (${Math.round(Buffer.byteLength(html) / 1024)} KiB).`);
