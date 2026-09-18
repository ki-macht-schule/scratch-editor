import React, {useEffect, useRef} from 'react';
import PropTypes from 'prop-types';
import {connect} from 'react-redux';
import classNames from 'classnames';

import Button from '../button/button.jsx';
import log from '../../lib/log';
import {
    getKiwiSaveUrl,
    saveProjectToKiwi,
    kiwiSaveErrorMessage,
    kiwiSaveSuccessText,
    kiwiSaveAlertId,
    KIWI_LOGO_URL
} from '../../lib/kiwi-project';
import {setProjectUnchanged} from '../../reducers/project-changed';
import {showAlertWithTimeout, closeAlertWithId} from '../../reducers/alerts';

import menuBarStyles from './menu-bar.css';
import styles from './kiwi-save-button.css';

// One in-flight POST. The save is several seconds; a second click would
// race the sha-lock. Module scope because mergeProps rebuilds the handler.
let kiwiSaveInFlight = false;

const KiwiSaveButton = ({kiwiSaveUrl, onSaveToKiwi}) => {
    const saveRef = useRef(onSaveToKiwi);
    saveRef.current = onSaveToKiwi;

    useEffect(() => {
        if (!kiwiSaveUrl) {
            return undefined;
        }
        const onKey = event => {
            const modifier = event.metaKey || event.ctrlKey;
            if (modifier && (event.key === 's' || event.key === 'S')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                saveRef.current();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [kiwiSaveUrl]);

    if (!kiwiSaveUrl) {
        return null;
    }

    return (
        <div className={menuBarStyles.menuBarItem}>
            <Button
                className={classNames(menuBarStyles.menuBarButton, styles.kiwiSaveButton)}
                iconClassName={styles.kiwiSaveIcon}
                iconSrc={KIWI_LOGO_URL}
                onClick={onSaveToKiwi}
            >
                {'In kiwi speichern'}
            </Button>
        </div>
    );
};

KiwiSaveButton.propTypes = {
    kiwiSaveUrl: PropTypes.string,
    onSaveToKiwi: PropTypes.func
};

const mapStateToProps = state => ({
    vm: state.scratchGui.vm
});

const mapDispatchToProps = dispatch => ({
    onProjectUnchanged: () => dispatch(setProjectUnchanged()),
    onShowKiwiSaving: () => showAlertWithTimeout(dispatch, 'kiwiSaving'),
    onShowKiwiSaveDone: (alertId, data) => showAlertWithTimeout(dispatch, alertId, data),
    onHideKiwiSaving: () => dispatch(closeAlertWithId('kiwiSaving'))
});

const mergeProps = (stateProps, dispatchProps, ownProps) => {
    const kiwiSaveUrl = getKiwiSaveUrl();
    const onSaveToKiwi = () => {
        if (!kiwiSaveUrl || kiwiSaveInFlight) {
            return;
        }
        kiwiSaveInFlight = true;
        dispatchProps.onShowKiwiSaving();
        saveProjectToKiwi(stateProps.vm)
            .then(data => {
                dispatchProps.onProjectUnchanged();
                dispatchProps.onShowKiwiSaveDone(kiwiSaveAlertId(data), {
                    message: kiwiSaveSuccessText(data)
                });
            })
            .catch(err => {
                dispatchProps.onHideKiwiSaving();
                log.error(err);
                alert(kiwiSaveErrorMessage(err)); // eslint-disable-line no-alert
            })
            .then(() => {
                kiwiSaveInFlight = false;
            });
    };
    return Object.assign({}, ownProps, stateProps, dispatchProps, {
        kiwiSaveUrl,
        onSaveToKiwi
    });
};

export default connect(
    mapStateToProps,
    mapDispatchToProps,
    mergeProps
)(KiwiSaveButton);
