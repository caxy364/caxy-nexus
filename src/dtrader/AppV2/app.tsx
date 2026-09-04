import React from 'react';

import { NotificationsProvider, SnackbarProvider } from '@deriv-com/quill-ui';

import initStore from '../Stores/init-store';
import ModulesProvider from '../Stores/Providers/modules-providers';
import TraderProviders from '../trader-providers';

import ServicesErrorSnackbar from './Components/ServicesErrorSnackbar';
import Notifications from './Containers/Notifications';
import AppShell from './Containers/AppShell/app-shell';

import 'sass/app.scss';

type AppTypes = {
    passthrough: {
        root_store: any;
        WS: any;
    };
};

const App = ({ passthrough }: AppTypes) => {
    const root_store = initStore(passthrough.root_store, passthrough.WS);
    const analyticsCalledRef = React.useRef(false);

    React.useEffect(() => {
        return () => root_store.ui.setPromptHandler(false);
    }, [root_store]);

    React.useEffect(() => {
        if (analyticsCalledRef.current) return;
        analyticsCalledRef.current = true;
    }, []);

    return (
        <TraderProviders store={root_store}>
            <ModulesProvider store={root_store}>
                <NotificationsProvider>
                    <SnackbarProvider>
                        <Notifications />
                        <AppShell />
                        <ServicesErrorSnackbar />
                    </SnackbarProvider>
                </NotificationsProvider>
            </ModulesProvider>
        </TraderProviders>
    );
};

export default App;
