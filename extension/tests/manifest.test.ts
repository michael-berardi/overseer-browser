import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable public key and least-privilege permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    expect(config).toContain("permissions: ['nativeMessaging', 'storage', 'scripting', 'tabs', 'windows', 'activeTab']");
    expect(config).toContain("host_permissions: ['https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*']");
    expect(config).toContain("optional_host_permissions: ['http://*/*', 'https://*/*']");
    expect(config).not.toContain(['debug', 'ger'].join(''));
    expect(config).not.toContain("'<all_urls>'");
  });

  it('declares the fixed extension identity in source', () => {
    const protocol = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8');
    expect(protocol).toContain('iabfdeokmilpklblkgccpjlekchfjcno');
    const forbidden = ['chrome.' + ['debug', 'ger'].join(''), 'chrome.web' + 'Request', 'chrome.' + 'history', 'chrome.' + 'bookmarks'];
    for (const api of forbidden) expect(protocol).not.toContain(api);
  });
});
