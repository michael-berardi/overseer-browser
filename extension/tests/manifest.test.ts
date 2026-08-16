import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable public key and least-privilege permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    expect(config).toContain("version: '0.1.1'");
    expect(config).toContain("permissions: ['nativeMessaging', 'storage', 'scripting', 'tabs', 'windows', 'activeTab']");
    expect(config).toContain("host_permissions: ['https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*']");
    expect(config).toContain("optional_host_permissions: ['<all_urls>']");
    expect(config).not.toMatch(/^\s*host_permissions:\s*\['<all_urls>'\]/m);
    expect(config).not.toContain('update_url');
    expect(config).toContain("connect-src https://analytics.libertydesign.studio");
    expect(config).not.toContain("connect-src *");
    expect(config).not.toContain(['debug', 'ger'].join(''));
  });

  it('declares the fixed extension identity in source', () => {
    const protocol = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8');
    expect(protocol).toContain('iabfdeokmilpklblkgccpjlekchfjcno');
    const forbidden = ['chrome.' + ['debug', 'ger'].join(''), 'chrome.web' + 'Request', 'chrome.' + 'history', 'chrome.' + 'bookmarks'];
    for (const api of forbidden) expect(protocol).not.toContain(api);
  });
  it('keeps the manual release verifier and environment-only publish path', () => {
    const verifier = readFileSync(new URL('../../scripts/verify_release.py', import.meta.url), 'utf8');
    const publisher = readFileSync(new URL('../../scripts/publish_chrome_web_store.py', import.meta.url), 'utf8');
    const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    expect(verifier).toContain("EXPECTED_VERSION = \"0.1.1\"");
    expect(verifier).toContain("EXPECTED_EXTENSION_ID = \"iabfdeokmilpklblkgccpjlekchfjcno\"");
    expect(verifier).toContain('must not declare an external update_url');
    expect(verifier).toContain("EXPECTED_EXTENSION_CSP");
    expect(publisher).toContain('CHROME_WEB_STORE_CLIENT_ID');
    expect(publisher).toContain('CHROME_WEB_STORE_CLIENT_SECRET');
    expect(publisher).toContain('CHROME_WEB_STORE_REFRESH_TOKEN');
    expect(publisher).toContain('CHROME_WEB_STORE_PUBLISHER_ID');
    expect(publisher).toContain('chromewebstore.googleapis.com/v2');
    expect(publisher).toContain('chromewebstore.googleapis.com/upload/v2');
    expect(publisher).not.toContain('client_secret=');
    expect(packageJson).toContain('"release:verify"');
    expect(packageJson).toContain('"release:publish"');
  });
});
