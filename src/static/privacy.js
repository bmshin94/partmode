const COOKIE_NAME = 'partmode_cookie_consent';
const COOKIE_VALUE = 'essential-v1';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180;
const banner = document.getElementById('pm-cookie-banner');
const essentialButtons = document.querySelectorAll('[data-cookie-essential]');
const resetButton = document.getElementById('pm-cookie-reset');
const status = document.getElementById('pm-cookie-status');

function readCookie(name) {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const entry of document.cookie.split(';')) {
    const candidate = entry.trim();
    if (candidate.startsWith(prefix)) {
      return decodeURIComponent(candidate.slice(prefix.length));
    }
  }
  return null;
}

function writePreference() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${encodeURIComponent(COOKIE_NAME)}=${encodeURIComponent(COOKIE_VALUE)}` +
    `; Max-Age=${COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
}

function deletePreference() {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${encodeURIComponent(COOKIE_NAME)}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

function updateStatus() {
  const essentialOnly = readCookie(COOKIE_NAME) === COOKIE_VALUE;
  if (status) {
    status.textContent = essentialOnly
      ? 'Current choice: essential storage only.'
      : 'No cookie choice is stored.';
  }
  return essentialOnly;
}

const hasEssentialPreference = updateStatus();
if (banner && !hasEssentialPreference) banner.hidden = false;

for (const button of essentialButtons) {
  button.addEventListener('click', () => {
    writePreference();
    updateStatus();
    if (banner) banner.hidden = true;
    // First-visit overlays are sequenced: surfaces that wait for the cookie
    // banner (the Studio template chooser) listen for this dismissal signal.
    document.dispatchEvent(new CustomEvent('pm-cookie-consent-dismissed'));
  });
}

resetButton?.addEventListener('click', () => {
  deletePreference();
  updateStatus();
  if (banner) banner.hidden = false;
});
