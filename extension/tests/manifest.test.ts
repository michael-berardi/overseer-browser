import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable source-build identity and least-privilege permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    expect(config).toContain("version: '0.1.2'");
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
});
