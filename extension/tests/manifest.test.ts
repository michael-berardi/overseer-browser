import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable identity and secure-by-default optional site permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    expect(config).toContain("version: '0.2.0'");
    expect(config).toContain("permissions: ['alarms', 'nativeMessaging', 'storage', 'scripting', 'tabs', 'userScripts', 'windows']");
    expect(config).toContain("host_permissions: ['https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*']");
    expect(config).toContain("optional_host_permissions: ['<all_urls>', 'http://*/*', 'https://*/*']");
    expect(config).not.toContain('activeTab');
    expect(config).not.toContain('update_url');
    expect(config).toContain("connect-src https://analytics.implosecybernetics.com");
    expect(config).not.toContain("connect-src *");
    expect(config).not.toContain(['debug', 'ger'].join(''));
  });

  it('keeps the native connection alive without requiring the popup', () => {
    const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    expect(background).toContain("NATIVE_RECONNECT_ALARM = 'overseer.native.reconnect.v1'");
    expect(background).toContain('chrome.alarms.onAlarm.addListener');
    expect(background).toContain('chrome.runtime.onStartup?.addListener');
    expect(background).toContain('chrome.runtime.onInstalled?.addListener');
    expect(background).toContain('chrome.alarms.clear(NATIVE_RECONNECT_ALARM)');
    expect(background).toContain('configureReconnectAlarm(enabled)');
  });

  it('declares the fixed extension identity in source', () => {
    const protocol = readFileSync(new URL('../src/protocol.ts', import.meta.url), 'utf8');
    expect(protocol).toContain('iabfdeokmilpklblkgccpjlekchfjcno');
    const forbidden = ['chrome.' + ['debug', 'ger'].join(''), 'chrome.web' + 'Request', 'chrome.' + 'history', 'chrome.' + 'bookmarks'];
    for (const api of forbidden) expect(protocol).not.toContain(api);
  });
});
