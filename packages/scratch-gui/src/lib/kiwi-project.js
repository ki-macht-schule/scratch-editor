import log from './log';

/* Kiwi: shared helpers for loading a Scratch project straight from Kiwi
 * content via a `?kiwi_project=` URL, and for posting an edited .sb3 back
 * through `?kiwi_save_url=`. Used by the initial seeding
 * (kiwi-project-loader-hoc) and the file menu (reset + In kiwi speichern),
 * so the same-origin guard and the fetch live in one place.
 */

// Hardcoded German: this seeding path is a Kiwi-only feature on a German-only
// deployment, so a plain alert avoids threading react-intl through the callers
// just for one string.
const KIWI_LOAD_ERROR =
    'Die Übungsvorlage konnte nicht geladen werden. ' +
    'Bitte lade die Seite neu oder öffne die Karte erneut.';

const KIWI_SAVE_ERROR =
    'Speichern in kiwi ist fehlgeschlagen. Bitte versuche es erneut.';

const kiwiSaveErrorMessage = err => {
    const code = err && err.code;
    if (code === 'conflict') {
        return 'Jemand hat inzwischen gespeichert.';
    }
    if (code === 'too_large') {
        return (err && err.message) || 'Die Datei ist zu groß.';
    }
    if (code === 'gitea_auth') {
        return 'Gitea-Sitzung abgelaufen. Bitte in kiwi neu verbinden.';
    }
    if (code === 'path_rejected' || code === 'foreign_origin' || code === 'zip_bomb') {
        return (err && err.message) || KIWI_SAVE_ERROR;
    }
    return (err && err.message) || KIWI_SAVE_ERROR;
};

const kiwiSaveSuccessText = data => {
    const committed = (data && data.committed) || [];
    const rejected = (data && data.rejected) || [];
    if (rejected.length && committed.length) {
        return (
            `${committed.length} Datei(en) in kiwi gespeichert. ` +
            `Nicht übernommen: ${rejected.join(', ')}`
        );
    }
    if (rejected.length) {
        return `Nichts ins Repo geschrieben. Nicht übernommen: ${rejected.join(', ')}`;
    }
    if (!committed.length) {
        return 'Keine Änderungen zu speichern';
    }
    return `${committed.length} Datei(en) in kiwi gespeichert`;
};

const kiwiSaveAlertId = data => (
    ((data && data.rejected) || []).length ? 'kiwiSavePartial' : 'kiwiSaveSuccess'
);

// Homescreen fruit mark (toast / intro). Scratch is on the same origin
// via /scratch/; APPLICATION_ROOT is /home in this deploy.
export const KIWI_LOGO_URL = '/home/static/img/kiwi_logo.png';

// Path after an optional APPLICATION_ROOT of `/home`. The homescreen contract
// test reads this literal. Rejects `/`, jupyter, geben, office, and anything
// that is not the Bereich scratch save.
export const KIWI_SAVE_PATTERN = /^\/mein-bereich\/[^/]+\/[^/]+\/[^/]+\/scratch-content\/save$/;

const isSameOriginPath = raw => raw.startsWith('/') && !raw.startsWith('//');

// The param carries a URL the browser fetches, so accept only a same-origin
// absolute path (leading single slash). This rejects absolute URLs to other
// origins and protocol-relative `//host` values -- the seed always comes from
// our own homescreen route.
const getKiwiProjectUrl = () => {
    const raw = new URLSearchParams(window.location.search).get('kiwi_project');
    if (!raw) return null;
    if (!isSameOriginPath(raw)) {
        log.warn(`kiwi_project ignored, not a same-origin path: ${raw}`);
        return null;
    }
    return raw;
};

// Save is default-deny: student launch never sets the param. The path must
// be the Bereich scratch save, optionally under `/home`.
const getKiwiSaveUrl = () => {
    const raw = new URLSearchParams(window.location.search).get('kiwi_save_url');
    if (!raw) return null;
    if (!isSameOriginPath(raw)) {
        log.warn(`kiwi_save_url ignored, not a same-origin path: ${raw}`);
        return null;
    }
    const pathname = raw.split(/[?#]/)[0];
    const stripped = pathname.replace(/^\/home(?=\/)/, '');
    if (!KIWI_SAVE_PATTERN.test(stripped)) {
        log.warn(`kiwi_save_url ignored, not a Bereich scratch save: ${raw}`);
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

const readSaveEnvelope = response =>
    response.json().catch(() => ({})).then(data => {
        if (!response.ok || !data || data.ok !== true) {
            const error = new Error(data.error || KIWI_SAVE_ERROR);
            error.code = data.code;
            throw error;
        }
        return data;
    });

// POST the VM's .sb3 at the allowlisted save URL. Same JSON envelope as
// Jupyter (`ok`, `committed`, `left_in_browser`, `rejected`).
const saveProjectToKiwi = vm => {
    const url = getKiwiSaveUrl();
    if (!url) {
        return Promise.reject(new Error(KIWI_SAVE_ERROR));
    }
    return vm.saveProjectSb3().then(blob =>
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {'Content-Type': 'application/octet-stream'},
            body: blob
        })
    ).then(readSaveEnvelope);
};

export {
    KIWI_LOAD_ERROR,
    KIWI_SAVE_ERROR,
    getKiwiProjectUrl,
    getKiwiSaveUrl,
    fetchKiwiProjectBuffer,
    saveProjectToKiwi,
    kiwiSaveErrorMessage,
    kiwiSaveSuccessText,
    kiwiSaveAlertId
};
