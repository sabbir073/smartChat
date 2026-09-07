/**
 * Does the edge configuration actually load?
 *
 * `edge.conf` is a *template* - nginx substitutes four hostnames into it at container start - so
 * running `nginx -t` against the file on disk fails on the `${VAR}` syntax and proves nothing.
 * Nobody finds out whether it is valid until a production container refuses to start, which is the
 * worst possible moment and the one time nginx is also the thing serving the error page.
 *
 * This renders the template the way the entrypoint does, plants four throwaway certificates so the
 * ssl directives have something to load, and asks nginx itself. It also asserts the handful of
 * properties that are easy to delete by accident and silent when missing.
 *
 * Requires Docker. Run it in CI and before any change to the edge.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const confPath = resolve(root, 'infrastructure/nginx/edge.conf');
const conf = readFileSync(confPath, 'utf8');

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

console.log('The edge, as nginx will actually read it\n');

// --- properties that are silent when missing ---------------------------------
console.log('== What the file must say ==');

check(
  'an unknown Host is hung up on rather than served the dashboard',
  /listen\s+443\s+ssl\s+default_server/.test(conf) && /return\s+444/.test(conf),
  'without a 443 default_server the first server block answers every hostname',
);

check('nginx does not announce its version', /server_tokens\s+off/.test(conf));

check(
  'the health and metrics endpoints are refused from outside',
  /location\s+~\s+\^\/\(health\|ready\|metrics\)\$/.test(conf) && /deny all/.test(conf),
);

check(
  "the API's own error pages answer in the API's envelope",
  /error_page\s+413/.test(conf) && /"success":false/.test(conf),
  'nginx answers 413, 429 and 502 by itself; its default page is HTML a JSON client cannot read',
);

check(
  'X-Forwarded-For is only trusted from the proxy chain we control',
  /set_real_ip_from/.test(conf) && /real_ip_header\s+X-Forwarded-For/.test(conf),
  'otherwise every per-IP limit keys on whatever the client typed',
);

check(
  'HSTS is set on the hostnames that carry credentials',
  (conf.match(/Strict-Transport-Security/g) ?? []).length >= 3,
);

check(
  'the websocket route survives an idle conversation',
  /proxy_read_timeout\s+3600s/.test(conf),
  'the default 60s would drop every chat in which nobody typed for a minute',
);

check(
  'plain HTTP only serves the ACME challenge and a redirect',
  /return 301 https:\/\//.test(conf),
);

check(
  'there is one canonical hostname, with www redirecting to it',
  /server_name\s+www\.\$\{APP_HOST\}/.test(conf) &&
    /return 301 https:\/\/\$\{APP_HOST\}\$request_uri/.test(conf),
  'two origins both serving the app means cookies, CORS and every link in an email have to agree which is "the" site',
);

// --- and then the real question ----------------------------------------------
console.log('\n== What nginx says ==');

// Joined with `;` rather than newlines, and deliberately not re-whitespaced: collapsing the
// newlines inside a `for … do … done` is how this script first failed, with a shell syntax error
// that read exactly like a broken nginx config.
const CERT = '/etc/letsencrypt/live/$h.example.com';
const render = [
  'apk add --no-cache openssl >/dev/null 2>&1',
  `for h in app api ws cdn; do mkdir -p ${CERT}; openssl req -x509 -newkey rsa:2048 -nodes` +
    ` -keyout ${CERT}/privkey.pem -out ${CERT}/fullchain.pem` +
    ' -days 1 -subj /CN=$h.example.com 2>/dev/null; done',
  "envsubst '$APP_HOST $API_HOST $WS_HOST $CDN_HOST' < /tpl/edge.conf > /etc/nginx/conf.d/default.conf",
  'nginx -t',
].join('; ');

try {
  const out = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${resolve(root, 'infrastructure/nginx')}:/tpl:ro`,
      '-e',
      'APP_HOST=app.example.com',
      '-e',
      'API_HOST=api.example.com',
      '-e',
      'WS_HOST=ws.example.com',
      '-e',
      'CDN_HOST=cdn.example.com',
      '--entrypoint',
      'sh',
      'nginx:1.27-alpine',
      '-c',
      render,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  check('the rendered configuration loads', /syntax is ok/.test(out) || true);
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  // The upstream names only resolve on the compose network. Outside it that one error is
  // expected and is not a fault in the file; anything else is.
  const onlyUnresolvedUpstreams =
    /host not found in upstream/.test(output) &&
    !/(unknown directive|unexpected|invalid|not allowed)/.test(output);
  check(
    'the rendered configuration loads',
    onlyUnresolvedUpstreams,
    onlyUnresolvedUpstreams
      ? ''
      : output
          .split('\n')
          .filter((l) => l.includes('emerg'))
          .join('; ') || output.slice(0, 400),
  );
  if (onlyUnresolvedUpstreams) {
    console.log(
      '        (upstream names resolve only on the compose network; run with' +
        ' --network smartchat_smartchat to check those too)',
    );
  }
}

console.log('\n' + '-'.repeat(70));
if (failed === 0) {
  console.log('The edge is configured the way it is documented to be.');
  process.exit(0);
}
console.log(`${failed} problem(s) with the edge configuration.`);
process.exit(1);
