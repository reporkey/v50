// Google Analytics 4 (gtag.js) bootstrap. Deliberately an external, same-origin file rather
// than an inline <script>: the site's CSP is `script-src 'self'` (no 'unsafe-inline'), so an
// inline snippet would be blocked. Keeping it here means we add GA without loosening the CSP.
// The companion loader tag (googletagmanager.com/gtag/js) lives in each page's <head>.
window.dataLayer = window.dataLayer || [];
function gtag() {
  dataLayer.push(arguments);
}
gtag('js', new Date());
gtag('config', 'G-TC9QY74257');
