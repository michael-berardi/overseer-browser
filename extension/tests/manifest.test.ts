import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');

describe('manifest privacy invariants', () => {
  it('uses the stable identity and secure-by-default optional site permissions', () => {
    expect(config).toContain('key: publicKey');
    expect(config).toContain('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A');
    expect(config).toContain('IDAQAB');
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(config).toContain(`version: '${version}'`);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    expect(readFileSync(new URL('../../cli/main.py', import.meta.url), 'utf8')).toContain(`CLI_VERSION = "${version}"`);
    expect(readFileSync(new URL('../../native_host/host.py', import.meta.url), 'utf8')).toContain(`HOST_VERSION = "${version}"`);
    expect(config).toContain("permissions: ['activeTab', 'tabCapture', 'offscreen', 'alarms', 'nativeMessaging', 'storage', 'scripting', 'tabs', 'userScripts', 'windows']");
    expect(config).toContain("host_permissions: ['<all_urls>', 'https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*']");
    expect(config).toContain("optional_host_permissions: ['<all_urls>', 'http://*/*', 'https://*/*']");
    // Recording uses a real popup gesture; no undeclared debugger escalation.
    expect(config).not.toMatch(/\b(?:optional_)?permissions:\s*\[[^\]]*['"]debugger['"]/);
    expect(config).not.toContain('update_url');
    expect(config).not.toContain("connect-src *");
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

// Scan extension sources and the generated manifest without embedding the forbidden strings.
describe('network privacy regression', () => {
  it('keeps retired collection routes out of sources and generated manifest', () => {
    const root = new URL('..', import.meta.url).pathname;
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    });
    const manifest = join(root, '.output/chrome-mv3/manifest.json');
    const paths = [...files(join(root, 'src')), ...files(join(root, 'entrypoints')), join(root, 'wxt.config.ts')];
    if (existsSync(manifest)) paths.push(manifest);
    const forbidden = new RegExp(['app', 'telemetry'].join('[-_]?') + '|analytics\\.(?:pareto|implose)cybernetics\\.com', 'i');
    for (const path of paths) expect(readFileSync(path, 'utf8'), path).not.toMatch(forbidden);
  });
});
