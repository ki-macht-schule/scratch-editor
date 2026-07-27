import bindAll from 'lodash.bindall';
import React from 'react';
import PropTypes from 'prop-types';
import {connect} from 'react-redux';

import log from '../lib/log';
import {KIWI_LOAD_ERROR, getKiwiProjectUrl, fetchKiwiProjectBuffer} from './kiwi-project';
import {setProjectUnchanged} from '../reducers/project-changed';
import {
    LoadingStates,
    getIsLoadingUpload,
    getIsShowingWithoutId,
    onLoadedProject,
    requestProjectUpload
} from '../reducers/project-state';
import {setProjectTitle} from '../reducers/project-title';
import {
    openLoadingProject,
    closeLoadingProject
} from '../reducers/modals';

/* Kiwi: load a pre-built Scratch project the same way JupyterLite loads a
 * notebook -- straight from Kiwi content, on open. The homescreen's
 * `/scratch-launch/<card>` route gates access and redirects here with
 * `?kiwi_project=<url>`, where <url> is a same-origin endpoint that zips the
 * card's unpacked project folder into a .sb3 on the fly (see the homescreen's
 * app/routes/scratch.py). We fetch that .sb3 and hand it to the VM.
 *
 * The loaded project is an editable SEED: it replaces the default project once,
 * on first open, and from then on the student edits freely -- nothing is
 * locked, and a reload re-seeds from content (there is no autosave to a server).
 *
 * We deliberately reuse the local-file upload state machine
 * (`requestProjectUpload` -> `LOADING_VM_FILE_UPLOAD` -> `vm.loadProject`
 * -> `onLoadedProject`) rather than the by-id project fetcher, because our
 * source is an in-hand ArrayBuffer, not a Scratch project id. This is the same
 * path `sb-file-uploader-hoc` drives for "Load from your computer", minus the
 * file chooser.
 */

/**
 * Higher Order Component that seeds the editor with a Scratch project fetched
 * from a `?kiwi_project=` URL. A no-op when the param is absent.
 * @param {React.Component} WrappedComponent component to wrap
 * @returns {React.Component} wrapped component with kiwi project seeding
 */
const KiwiProjectLoaderHOC = function (WrappedComponent) {
    class KiwiProjectLoaderComponent extends React.Component {
        constructor (props) {
            super(props);
            bindAll(this, [
                'fetchProject',
                'loadIntoVM'
            ]);
            this.projectUrl = getKiwiProjectUrl();
            // Optional display title (the .sb3/project.json carries no title);
            // the launcher may pass the card title as `?kiwi_title=`.
            this.projectTitle = new URLSearchParams(window.location.search).get('kiwi_title');
            // The fetched .sb3 bytes, once available.
            this.buffer = null;
            // Guards so the one-shot seed never re-fires: `requested` after we
            // kick the upload state machine, `loaded` after loadProject settles
            // (onLoadedProject returns to SHOWING_WITHOUT_ID, which would
            // otherwise re-trigger the request below).
            this.requested = false;
            this.loaded = false;
        }
        componentDidMount () {
            if (this.projectUrl) {
                this.fetchProject();
            }
        }
        componentDidUpdate (prevProps) {
            // Once the default project is showing, the upload transition is
            // valid (see requestProjectUpload's accepted states); request it as
            // soon as the bytes are in hand.
            if (
                this.buffer &&
                !this.requested &&
                !this.loaded &&
                this.props.isShowingWithoutId
            ) {
                this.requested = true;
                this.props.requestProjectUpload(this.props.loadingState);
            }
            // The state machine has moved to LOADING_VM_FILE_UPLOAD: now feed
            // the bytes to the VM (mirrors sb-file-uploader's onload step).
            if (this.props.isLoadingUpload && !prevProps.isLoadingUpload && this.buffer) {
                this.loadIntoVM();
            }
        }
        fetchProject () {
            fetchKiwiProjectBuffer(this.projectUrl)
                .then(buffer => {
                    this.buffer = buffer;
                    // Nudge a re-render so componentDidUpdate re-evaluates the
                    // request gate even if no other prop changed meanwhile.
                    this.forceUpdate();
                })
                .catch(err => {
                    // Surface the failure: without this the student silently
                    // lands in the empty default project with no idea why.
                    log.error(err);
                    alert(KIWI_LOAD_ERROR); // eslint-disable-line no-alert
                });
        }
        loadIntoVM () {
            const buffer = this.buffer;
            this.loaded = true;
            this.buffer = null;
            this.props.onLoadingStarted();
            let success = false;
            this.props.vm.loadProject(buffer)
                .then(() => {
                    success = true;
                    if (this.projectTitle) {
                        this.props.onSetProjectTitle(this.projectTitle);
                    }
                })
                .catch(err => {
                    log.error(err);
                    alert(KIWI_LOAD_ERROR); // eslint-disable-line no-alert
                })
                .then(() => {
                    this.props.onLoadingFinished(this.props.loadingState, success);
                    // A freshly seeded project is unmodified: don't fire the
                    // unsaved-changes guard until the student actually edits.
                    this.props.onProjectUnchanged();
                });
        }
        render () {
            const {
                isLoadingUpload,
                isShowingWithoutId,
                loadingState,
                onLoadingFinished,
                onLoadingStarted,
                onProjectUnchanged,
                onSetProjectTitle,
                requestProjectUpload: requestProjectUploadProp,
                vm,
                ...componentProps
            } = this.props;
            return (
                <WrappedComponent
                    vm={vm}
                    {...componentProps}
                />
            );
        }
    }

    KiwiProjectLoaderComponent.propTypes = {
        isLoadingUpload: PropTypes.bool,
        isShowingWithoutId: PropTypes.bool,
        loadingState: PropTypes.oneOf(LoadingStates),
        onLoadingFinished: PropTypes.func,
        onLoadingStarted: PropTypes.func,
        onProjectUnchanged: PropTypes.func,
        onSetProjectTitle: PropTypes.func,
        requestProjectUpload: PropTypes.func,
        vm: PropTypes.shape({
            loadProject: PropTypes.func
        })
    };
    const mapStateToProps = state => {
        const loadingState = state.scratchGui.projectState.loadingState;
        return {
            isLoadingUpload: getIsLoadingUpload(loadingState),
            isShowingWithoutId: getIsShowingWithoutId(loadingState),
            loadingState: loadingState,
            vm: state.scratchGui.vm
        };
    };
    const mapDispatchToProps = (dispatch, ownProps) => ({
        onLoadingFinished: (loadingState, success) => {
            dispatch(onLoadedProject(loadingState, ownProps.canSave, success));
            dispatch(closeLoadingProject());
        },
        onLoadingStarted: () => dispatch(openLoadingProject()),
        onProjectUnchanged: () => dispatch(setProjectUnchanged()),
        onSetProjectTitle: title => dispatch(setProjectTitle(title)),
        requestProjectUpload: loadingState => dispatch(requestProjectUpload(loadingState))
    });
    const mergeProps = (stateProps, dispatchProps, ownProps) => Object.assign(
        {}, stateProps, dispatchProps, ownProps
    );
    return connect(
        mapStateToProps,
        mapDispatchToProps,
        mergeProps
    )(KiwiProjectLoaderComponent);
};

export {
    KiwiProjectLoaderHOC as default
};
