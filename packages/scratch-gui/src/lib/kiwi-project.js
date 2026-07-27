import log from './log';

/* Kiwi: shared helpers for loading a Scratch project straight from Kiwi
 * content via a `?kiwi_project=` URL. Used by both the initial seeding
 * (kiwi-project-loader-hoc) and the "Auf Übungsvorlage zurücksetzen" menu
 * action (file-menu), so the same-origin guard and the fetch live in one place.
 */

// Hardcoded German: this seeding path is a Kiwi-only feature on a German-only
// deployment, so a plain alert avoids threading react-intl through the callers
// just for one string.
const KIWI_LOAD_ERROR =
    'Die Übungsvorlage konnte nicht geladen werden. ' +
    'Bitte lade die Seite neu oder öffne die Karte erneut.';

// The param carries a URL the browser fetches, so accept only a same-origin
// absolute path (leading single slash). This rejects absolute URLs to other
// origins and protocol-relative `//host` values -- the seed always comes from
// our own homescreen route.
const getKiwiProjectUrl = () => {
    const raw = new URLSearchParams(window.location.search).get('kiwi_project');
    if (!raw) return null;
    if (!raw.startsWith('/') || raw.startsWith('//')) {
        log.warn(`kiwi_project ignored, not a same-origin path: ${raw}`);
        return null;
    }
    return raw;
};

// same-origin so the homescreen auth cookie rides along and the route's
// card/asset gating applies to this fetch too. Resolves to the .sb3 bytes.
const fetchKiwiProjectBuffer = url =>
    fetch(url, {credentials: 'same-origin'}).then(response => {
        if (!response.ok) {
            throw new Error(`kiwi_project fetch failed: ${response.status}`);
        }
        return response.arrayBuffer();
    });

export {
    KIWI_LOAD_ERROR,
    getKiwiProjectUrl,
    fetchKiwiProjectBuffer
};
