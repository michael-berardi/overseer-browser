import { defineConfig } from 'wxt';

const publicKey =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtsB8TWcXWqPl4DKi7y9AEri4e0ZXYzLEv/WM3T+qY6IkAskSX/WNcWwJNETRm5f6Pq02XONBu0SxJGW5gjVWcQ6+zd6Ke5jl/xKHFAJHdFOwXxul7qDlqSt4kTDiD7xECAT5c83FzhXHtiNO8xSM4cfFN40zK+moBA/mStTysLs1xHyG79ia19yOE2kNY9QmnvLSBRlfwrTxI7AbPWbEKV9LAYsucvqH40MdAaHS9Gem52dbdr/RUjy47rcLL/Cvm5buTHS7BSdj8fVGyQNCV6DXxs7ix7OLuNnHjC0lgdd25EhivYJ2h1oTFy7HCJ8Pg/fuRaImOODSdRcFNDcJswIDAQAB';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'OverSeer Browser',
    short_name: 'OverSeer',
    description: 'Local-only browser control and meeting reminders.',
    version: '0.1.0',
    key: publicKey,
    permissions: ['nativeMessaging', 'storage', 'scripting', 'tabs', 'windows', 'activeTab'],
    host_permissions: ['https://meet.google.com/*', 'https://zoom.us/*', 'https://*.zoom.us/*'],
    optional_host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png',
    },
    action: {
      default_title: 'OverSeer Browser',
      default_popup: 'popup.html',
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
