import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable source-build identity and autonomous site permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    expect(config).toContain("version: '0.1.3'");
    expect(config).toContain("permissions: ['nativeMessaging', 'storage', 'scripting', 'tabs', 'windows']");
    expect(config).toContain("host_permissions: ['<all_urls>']");
    expect(config).not.toContain('optional_host_permissions');
    expect(config).not.toContain('activeTab');
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
