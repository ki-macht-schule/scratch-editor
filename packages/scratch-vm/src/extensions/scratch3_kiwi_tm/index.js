const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const log = require('../../util/log');
const JSZip = require('jszip');
const tf = require('@tensorflow/tfjs');
const Video = require('../../io/video');

// Same-origin hand-off written by the Teachable-Machine trainer. Must stay in
// sync with apps/teachable-machine/src/util/modelHandoff.ts. Slots are
// per-target (`<base>:<target>`); scratch only reads its own model, so a
// race/rex/notebook model can never leak into a Scratch project.
const DB_NAME = 'kiwi-tm-handoff';
const STORE = 'kv';
const KEY_MODEL = 'handoff-model:scratch'; // model-only .zip (model.json, weights.bin, metadata.json)
const KEY_META = 'handoff-meta:scratch'; // { schemaVersion, target, labels, savedAt }

// Highest hand-off format version this extension understands. A model is
// accepted iff its `minReaderVersion` (the compat gate the trainer declares) is
// <= this, so newer-but-backward-compatible models still load; one needing a
// newer reader is refused instead of crashing. See teachable-machine/CONTRACT.md.
const READER_VERSION = 1;

// The trainer is opened in a new tab:
//  - return=close: hand off via IndexedDB and post `kiwi-model-updated` back to
//    this tab, then close.
//  - restore=1: reload the previously handed-off project so the student keeps
//    training instead of starting over (no-op on the first open).
const TRAINER_URL = '/teachable-machine/launch?target=scratch&contract=1&return=close&restore=1';

// How often the webcam frame is classified while the camera is on.
const PREDICT_INTERVAL_MS = 200;

// Kiwi-green rounded tile with "TM".
// eslint-disable-next-line @stylistic/max-len
const blockIconURI = 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
    '<rect x="2" y="2" width="36" height="36" rx="9" fill="#3aa757"/>' +
    '<text x="20" y="26" font-family="Helvetica,Arial,sans-serif" font-size="15" font-weight="700" ' +
    'text-anchor="middle" fill="#ffffff">TM</text></svg>'
);
const menuIconURI = blockIconURI;

const openHandoffDb = () => new Promise((resolve, reject) => {
    // Open without a version so we never clobber the store the trainer created.
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

const idbGet = (db, key) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const r = tx.objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});

/**
 * kiwi-tm: brings a Teachable-Machine model trained in the kiwi trainer into
 * self-hosted Scratch. The model travels via the same-origin IndexedDB hand-off;
 * inference runs locally with tf.js on the Scratch webcam feed, matching the
 * trainer's preprocessing (centre-crop + `x/127 - 1`, see @knicos/tm-image).
 */
class ScratchKiwiTM {
    constructor (runtime) {
        this.runtime = runtime;

        this._labels = [];
        this._model = null; // full tf.js LayersModel (image -> probabilities)
        this._imageSize = 224;
        this._grayscale = false;

        this._probabilities = []; // aligned with this._labels, 0..1
        this._top = ''; // label with the highest probability
        this._videoOn = false;
        this._loading = false;
        this._busy = false; // a classification is in flight

        this._listenForTrainerReturn();
        // Cover the "trained, then navigated to Scratch" flow where a model is
        // already waiting when the extension is added.
        this.loadModel();

        this._loop = this._loop.bind(this);
        setTimeout(this._loop, PREDICT_INTERVAL_MS);
    }

    getInfo () {
        return {
            id: 'kiwitm',
            name: 'Kiwi TM',
            blockIconURI,
            menuIconURI,
            blocks: [
                {
                    opcode: 'openTrainer',
                    blockType: BlockType.COMMAND,
                    text: 'Modell trainieren'
                },
                '---',
                {
                    opcode: 'setVideo',
                    blockType: BlockType.COMMAND,
                    text: 'Kamera [STATE]',
                    arguments: {
                        STATE: {type: ArgumentType.STRING, menu: 'videoState', defaultValue: 'on'}
                    }
                },
                {
                    opcode: 'topClass',
                    blockType: BlockType.REPORTER,
                    text: 'erkanntes Objekt'
                },
                {
                    opcode: 'classConfidence',
                    blockType: BlockType.REPORTER,
                    text: 'Sicherheit fuer [CLASS] (%)',
                    arguments: {
                        CLASS: {type: ArgumentType.STRING, menu: 'classes'}
                    }
                },
                {
                    opcode: 'whenDetects',
                    blockType: BlockType.HAT,
                    text: 'wenn Kamera [CLASS] erkennt',
                    arguments: {
                        CLASS: {type: ArgumentType.STRING, menu: 'classes'}
                    }
                },
                {
                    opcode: 'isModelLoaded',
                    blockType: BlockType.BOOLEAN,
                    text: 'Modell geladen?'
                }
            ],
            menus: {
                videoState: {
                    acceptReporters: false,
                    items: [
                        {text: 'an', value: 'on'},
                        {text: 'aus', value: 'off'}
                    ]
                },
                classes: 'getClassMenu'
            }
        };
    }

    getClassMenu () {
        return this._labels.length ? this._labels.slice() : ['(kein Modell)'];
    }

    async loadModel () {
        if (this._loading) return;
        this._loading = true;
        try {
            const db = await openHandoffDb();
            if (!db.objectStoreNames.contains(STORE)) {
                // Opening a non-existent DB just created an empty one at version 1.
                // Delete it so the trainer's versioned open still fires
                // onupgradeneeded and creates the store.
                db.close();
                indexedDB.deleteDatabase(DB_NAME);
                log.warn('kiwi-tm: no hand-off yet; train a model first');
                return;
            }
            const zipBlob = await idbGet(db, KEY_MODEL);
            const handoffMeta = await idbGet(db, KEY_META);
            db.close();
            if (!zipBlob) {
                log.warn('kiwi-tm: no model in hand-off; train a model first');
                return;
            }
            if (handoffMeta) {
                const need = handoffMeta.minReaderVersion == null ?
                    handoffMeta.schemaVersion : handoffMeta.minReaderVersion;
                if (need > READER_VERSION) {
                    log.error(
                        `kiwi-tm: hand-off needs reader v${need} (this understands v${READER_VERSION}); ` +
                        `ignoring model. See teachable-machine/CONTRACT.md`
                    );
                    return;
                }
            }

            const zip = await JSZip.loadAsync(zipBlob);
            const meta = JSON.parse(await zip.file('metadata.json').async('string'));
            const modelJson = JSON.parse(await zip.file('model.json').async('string'));
            const weightData = await zip.file('weights.bin').async('arraybuffer');

            const model = await tf.loadLayersModel({
                load: async () => ({
                    modelTopology: modelJson.modelTopology,
                    weightSpecs: modelJson.weightsManifest[0].weights,
                    weightData
                })
            });

            if (this._model) this._model.dispose();
            this._model = model;
            this._labels = Array.isArray(meta.labels) ? meta.labels : [];
            this._imageSize = meta.imageSize || 224;
            this._grayscale = Boolean(meta.grayscale);
            this._probabilities = new Array(this._labels.length).fill(0);
            this._top = '';
            log.info(`kiwi-tm: model loaded with ${this._labels.length} classes: ${this._labels.join(', ')}`);
        } catch (e) {
            log.error('kiwi-tm: failed to load model from hand-off', e);
        } finally {
            this._loading = false;
        }
    }

    setVideo (args) {
        const video = this.runtime.ioDevices && this.runtime.ioDevices.video;
        if (!video) return;
        if (args.STATE === 'off') {
            this._videoOn = false;
            video.disableVideo();
            return;
        }
        this._videoOn = true;
        video.mirror = true;
        const enable = video.enableVideo();
        if (enable && typeof enable.catch === 'function') {
            enable.catch(e => log.error('kiwi-tm: camera could not be enabled', e));
        }
    }

    topClass () {
        return this._top;
    }

    classConfidence (args) {
        const i = this._labels.indexOf(args.CLASS);
        if (i < 0) return 0;
        return Math.round((this._probabilities[i] || 0) * 100);
    }

    whenDetects (args) {
        return this._top !== '' && this._top === args.CLASS;
    }

    isModelLoaded () {
        return Boolean(this._model);
    }

    openTrainer () {
        if (typeof window !== 'undefined') {
            window.open(TRAINER_URL, '_blank');
        }
    }

    // Grab a webcam frame, match the trainer's preprocessing and update the
    // cached probabilities. Reporters/hats read the cache synchronously.
    async _classify () {
        const video = this.runtime.ioDevices && this.runtime.ioDevices.video;
        if (!video) return;
        const frame = video.getFrame({format: Video.FORMAT_CANVAS, dimensions: [480, 360]});
        if (!frame) return;

        const size = this._imageSize;
        // Centre-crop to a square, then scale to the model's input size (same as
        // @knicos/tm-image cropTo).
        const side = Math.min(frame.width, frame.height);
        const sx = (frame.width - side) / 2;
        const sy = (frame.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(frame, sx, sy, side, side, 0, 0, size, size);

        const logits = tf.tidy(() => {
            let img = tf.browser.fromPixels(canvas).toFloat();
            if (this._grayscale) img = img.mean(2).expandDims(2);
            const normalized = img.div(127).sub(1).expandDims(0);
            return this._model.predict(normalized);
        });
        const data = await logits.data();
        logits.dispose();

        this._probabilities = Array.from(data);
        let best = 0;
        for (let i = 1; i < data.length; i++) {
            if (data[i] > data[best]) best = i;
        }
        this._top = this._labels[best] || '';
    }

    _loop () {
        const next = () => setTimeout(this._loop, PREDICT_INTERVAL_MS);
        if (this._videoOn && this._model && !this._busy) {
            this._busy = true;
            this._classify()
                .catch(e => log.error('kiwi-tm: classification failed', e))
                .finally(() => {
                    this._busy = false;
                    next();
                });
            return;
        }
        next();
    }

    // When the trainer tab hands off a fresh model it posts this message back to
    // its opener (this tab). Reload so the new classes are available at once.
    _listenForTrainerReturn () {
        if (typeof window === 'undefined') return;
        window.addEventListener('message', ev => {
            if (ev.origin !== window.location.origin) return;
            if (ev.data && ev.data.type === 'kiwi-model-updated') {
                this.loadModel();
            }
        });
    }
}

module.exports = ScratchKiwiTM;
